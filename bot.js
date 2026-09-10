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
      console.error("خەلەتی لە کلیلەک دا هەیە:", err.message);
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

// پشکنینا باڵانسێ تۆکەنێ د والێتێ دا
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

// ۱. فەنکشنا کڕینێ
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

// ۲. فەنکشنا فرۆتنێ
async function executeSell(selectedWallet, inputMint, rawTokenAmount) {
  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: rawTokenAmount,
      slippageBps: 250
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

// Start Command
bot.start((ctx) => {
  let msg = `👤 بۆتێ ڕاستەقینە و ئەکادیمی یێ ترەیدێ ئامادەیە.\n\nژمارەیا والێتێن چالاک: *${wallets.length}*\n\nلیست:\n`;
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

// ۳. کارپێکرنا سیستەمێ ئەکادیمی یێ سەربەخۆ و سروشتی
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم نوکە یێ د حالەتێ کارکرنێ دا!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🌿 **مۆدێ والێتێن ڕاستەقینە (Human Trader Simulation) دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• شێواز: کڕین و فرۆتن لێک جودانە و د یەک دەمدا ناهێنە کرن.\n• ڕاگرتن: ب فەرمانا /stop\n• مەودایێ دەمی: ناڤبەرا هەر تەڤگەرەکێ د ناڤبەرا ۸ بۆ ۲۲ خولەکان دایە.`, { parse_mode: 'Markdown' });

  const executeOrganicAction = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەلبژارتنا والێتەکێ ب شێوەیێ ڕەندەم
    const randomWalletIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randomWalletIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBalance = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      // بڕیاردان: ئایا کڕین بهێتە کرن یان فرۆتن؟
      // ئەگەر تۆکەن تێدا هەبیت: ٦۰٪ چانس هەیە بکڕیت، ٤۰٪ بفرۆشیت. ئەگەر تۆکەن نەبیت، نەچاری کڕینێیە.
      let doBuy = true;
      if (tokenBal.uiAmount > 0.5) {
        doBuy = Math.random() < 0.60;
      }

      // ئەگەر باڵانسێ SOL کێم بوو ژ 0.04 SOL، فرۆتنێ هەلدبژێریت
      if (solBalance < 0.04 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 0.5) {
        doBuy = false;
      }

      if (doBuy) {
        // ۱. پڕۆسەیا کڕینێ بتنێ (~$5-$6 / 0.035 - 0.042 SOL)
        const randomSol = (Math.random() * (0.042 - 0.035) + 0.035).toFixed(5);
        const txid = await executeBuy(activeWallet, ca, parseFloat(randomSol));
        ctx.reply(`🟢 [مامەلە #${currentLoop} | والێت ${randomWalletIdx + 1} (${shortAddr})]\nکڕینا سروشتی ئەنجامدرا (${randomSol} SOL):\nhttps://solscan.io/tx/${txid}`);
      } else {
        // ۲. پڕۆسەیا فرۆتنێ بتنێ (د ناڤبەرا ۳۰٪ هەتا ۷۰٪ ژ تۆکەنێن وێ والێتێ دفرۆشیت، نەکو هەمیا!)
        const sellPercent = Math.random() * (0.70 - 0.30) + 0.30;
        const rawTokensToSell = Math.floor(BigInt(tokenBal.rawAmount) * BigInt(Math.floor(sellPercent * 100)) / 100n).toString();

        if (BigInt(rawTokensToSell) > 0n) {
          const txid = await executeSell(activeWallet, ca, rawTokensToSell);
          ctx.reply(`🔴 [مامەلە #${currentLoop} | والێت ${randomWalletIdx + 1} (${shortAddr})]\nفرۆتنا سەربەخۆ (${(sellPercent * 100).toFixed(0)}% تۆکەن):\nhttps://solscan.io/tx/${txid}`);
        }
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل سەر مامەلەیا #${currentLoop}: ${err.message || 'خەلەتیەک ڕوویدا'}`);
    }

    if (isRunning24h) {
      // دەمەکێ درێژ و ڕاستەقینە د ناڤبەرا ۸ بۆ ۲۲ خولەکاندا (٤٨٠,٠٠٠ بۆ ١,٣٢٠,٠٠٠ چرکە)
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
console.log('Organic Human-Simulated Bot is running...');
