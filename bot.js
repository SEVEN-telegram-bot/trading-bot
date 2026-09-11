const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: زانیاریێن پێدڤی نینن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

// لۆدکرنا والێتان
const wallets = [];
const keysArray = PRIVATE_KEYS_RAW.split(',').map(k => k.trim()).filter(k => k.length > 0);

for (const key of keysArray) {
  try {
    wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
  } catch (e) {
    try {
      wallets.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))));
    } catch (err) {
      console.error("خەلەتی ل کلیلێ دا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک نەهاتە بارکرن!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// پشکنینا باڵانسێ تۆکەنێ
async function getTokenBalance(walletPubkey, mintPubkeyStr) {
  try {
    const response = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: new PublicKey(mintPubkeyStr)
    });
    if (response.value.length === 0) return { rawAmount: '0', uiAmount: 0 };
    const tokenAccount = response.value[0].account.data.parsed.info.tokenAmount;
    return {
      rawAmount: tokenAccount.amount,
      uiAmount: tokenAccount.uiAmount || 0
    };
  } catch (err) {
    return { rawAmount: '0', uiAmount: 0 };
  }
}

// ۱. کڕین ب ٥ بۆ ۷ دۆلار (0.035 - 0.048 SOL)
async function executeBuy(selectedWallet, outputMint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: outputMint,
      amount: lamports,
      slippageBps: 200
    },
    timeout: 15000
  });

  const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
    quoteResponse: quoteRes.data,
    userPublicKey: selectedWallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([selectedWallet]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return txid;
}

// ۲. فرۆتن ب قەبارێ ٥ بۆ ۷ دۆلار (دۆزینەوەی دەقیقی بڕێ تۆکەن)
async function executeSellFixedUsd(selectedWallet, inputMint, targetSolAmount) {
  const targetLamports = Math.floor(targetSolAmount * LAMPORTS_PER_SOL);

  // ل ڤێرە وەرگرتنی کوۆت دکەین دا بزانین چەند تۆکەن دکەتە ئەو بڕە SOLە
  const reverseQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: inputMint,
      amount: targetLamports,
      slippageBps: 200
    },
    timeout: 15000
  });

  const tokenAmountToSell = reverseQuote.data.outAmount;

  // دەرهێنانی کوۆتی فرۆتن بۆ ئەو بڕە تۆکەنە
  const sellQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: tokenAmountToSell,
      slippageBps: 250
    },
    timeout: 15000
  });

  const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
    quoteResponse: sellQuote.data,
    userPublicKey: selectedWallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([selectedWallet]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return { txid, solReceived: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4) };
}

// Start Command
bot.start((ctx) => {
  let msg = `👤 بۆتێ ڕاستەقینە و ئەکادیمی یێ ترەیدێ ئامادەیە.\n\nژمارەیا والێتان: *${wallets.length}*\n\nلیست:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Balance Command
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ جزدانان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ خەلەتی: ${error.message}`);
  }
});

// ۳. کارپێکرنا سیستەمێ سروشتی
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم نوکە یێ د حالەتێ کارکرنێ دا!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🌿 **مۆدێ ئەکادیمی یێ والێتێن ڕاستەقینە دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• قەبارە: هەر کڕین یان فرۆتنەک د ناڤبەرا ٥ بۆ ۷ دۆلاران دایە.\n• شێواز: کڕین و فرۆتن سەربەخۆنە و د یەک دەمدا ناهێنە کرن.\n• دەم: مەودایێ ۸ بۆ ۲۲ خولەکان ب ڕەندەم.\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeOrganicAction = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const randomWalletIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randomWalletIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBalance = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      // قەبارێ ڕەندەم یێ ٥ بۆ ۷ دۆلار (0.035 هەتا 0.048 SOL)
      const randomSolAmount = (Math.random() * (0.048 - 0.035) + 0.035).toFixed(5);

      // بڕیاردان: کڕین یان فرۆتن
      let doBuy = true;
      if (tokenBal.uiAmount > 5) {
        doBuy = Math.random() < 0.60; // ٦۰٪ چانس بۆ کڕین
      }

      if (solBalance < 0.04 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) {
        doBuy = false;
      }

      if (doBuy) {
        // ۱. کڕین بتنێ ب ٥ بۆ ۷ دۆلار
        const txid = await executeBuy(activeWallet, ca, parseFloat(randomSolAmount));
        ctx.reply(`🟢 [مامەلە #${currentLoop} | والێت ${randomWalletIdx + 1} (${shortAddr})]\nکڕینا سروشتی ئەنجامدرا (~${randomSolAmount} SOL / $5-$7):\nhttps://solscan.io/tx/${txid}`);
      } else {
        // ۲. فرۆتن بتنێ ب ٥ بۆ ۷ دۆلار
        const sellResult = await executeSellFixedUsd(activeWallet, ca, parseFloat(randomSolAmount));
        ctx.reply(`🔴 [مامەلە #${currentLoop} | والێت ${randomWalletIdx + 1} (${shortAddr})]\nفرۆتنا سروشتی ئەنجامدرا (~${sellResult.solReceived} SOL / $5-$7):\nhttps://solscan.io/tx/${sellResult.txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل سەر مامەلەیا #${currentLoop}: ${err.message || 'خەلەتیەک ڕوویدا'}`);
    }

    if (isRunning24h) {
      // ناڤبەرا ۸ بۆ ۲۲ خولەکان
      const nextDelay = Math.floor(Math.random() * (1320000 - 480000)) + 480000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ تەڤگەرا بهێت (#${currentLoop + 1}) دێ هێتە ئەنجامدان پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(executeOrganicAction, nextDelay);
    }
  };

  executeOrganicAction();
});

// ڕاگرتن
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 سیستەم هاتە ڕاگرتن.\nسەرجەم ترانزاکشن: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پڕۆسەیەک کار ناکەت.');
  }
});

bot.launch();
console.log('Fixed USD 5-7 Stealth Bot is running...');
