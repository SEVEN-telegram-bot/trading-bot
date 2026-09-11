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
      console.error("خەلەتی د کلیلێ دا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک نەهاتە بارکرن!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// سنوورێن چارتی (ل دووڤ وێنەیی)
const SUPPORT_PRICE = 0.2150;   // ئەگەر نرخ گەهشتە ڤێرە یان خوارتر، بتنێ دکڕیت (کەندلا کەسک)
const RESISTANCE_PRICE = 0.2350; // ئەگەر گەهشتە ڤێرە یان ژوورتر، دەست ب فرۆتنا سوودی دکەت

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// وەرگرتنا بهایێ ئێکسەری یێ تۆکەنێ ژ کۆتێ Jupiter
async function getCurrentTokenPrice(ca) {
  try {
    const res = await axios.get('https://public.jupiterapi.com/quote', {
      params: {
        inputMint: ca,
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC Mint
        amount: 1000000, // 1 Token (Assuming 6 decimals)
        slippageBps: 100
      },
      timeout: 10000
    });
    return parseFloat(res.data.outAmount) / 1000000;
  } catch (e) {
    return 0.2200; // نرخی مەزەندەکراو ئەگەر ئەی پی ئای نەخوێند
  }
}

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

// کڕین
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

// فرۆتن ب قەبارێ دیارکری ($5 - $7)
async function executeSellFixedUsd(selectedWallet, inputMint, targetSolAmount) {
  const targetLamports = Math.floor(targetSolAmount * LAMPORTS_PER_SOL);

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
  let msg = `📊 بۆتێ شیکاری و ڕێکخستنا چارتی (Chart MM Bot) ئامادەیە.\n\nژمارەیا والێتان: *${wallets.length}*\n\nلیست:\n`;
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
    ctx.reply(`❌ کێشە: ${error.message}`);
  }
});

// دەستپێکرنا ستراتیژییا چارتی
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم پێشتر هاتیە دەستپێکرن و چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`📈 **سیستەمێ ژیرێ شیکاریا چارتی دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• پشتەڤانی (Support): $${SUPPORT_PRICE} (ل ڤێرە تەنێ دکڕیت دا چارتی ڕاگرت)\n• بەربەست (Resistance): $${RESISTANCE_PRICE} (ل ڤێرە دەست ب فرۆتنێ دکەت)\n• دەمێ تەڤگەران: ۸ بۆ ۲۲ خولەکان ب شێوەیێ ڕەندەم\n• قەبارە: $5 بۆ $7 د هەر ترانزاکشنەکێ دا\n• ڕاوەستان: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeChartStrategy = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const randomWalletIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randomWalletIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const currentPrice = await getCurrentTokenPrice(ca);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);
      const solBalance = await connection.getBalance(activeWallet.publicKey);

      // دیارکرنا کڕین یان فرۆتن ل سەر بنەمایێ چارتی
      let action = 'BUY';

      if (currentPrice <= SUPPORT_PRICE) {
        // ۱. نرخ نزمە -> پالدانا چارتی ب کڕینێ (Green Candles)
        action = 'BUY';
      } else if (currentPrice >= RESISTANCE_PRICE && tokenBal.uiAmount > 5) {
        // ۲. نرخ گەهشتیە گۆپیتکێ -> فرۆتنا قازانجی (Cool-off)
        action = 'SELL';
      } else {
        // ۳. د ناڤبەرا ڕەنجێ دا -> ۷۰٪ کڕین، ۳۰٪ فرۆتن بۆ دروستکرنا ڤۆلیۆمێ سروشتی
        if (tokenBal.uiAmount > 5 && solBalance > 0.04 * LAMPORTS_PER_SOL) {
          action = Math.random() < 0.70 ? 'BUY' : 'SELL';
        } else {
          action = 'BUY';
        }
      }

      const randomSolAmount = (Math.random() * (0.048 - 0.035) + 0.035).toFixed(5);

      if (action === 'BUY') {
        const txid = await executeBuy(activeWallet, ca, parseFloat(randomSolAmount));
        ctx.reply(`🟢 [چارت | #${currentLoop} | والێت ${randomWalletIdx + 1} (${shortAddr})]\nکڕینا پاراستنا چارتی ئەنجامدرا (~${randomSolAmount} SOL | $5-$7):\nبهایێ نوکە: ~$${currentPrice.toFixed(4)}\nhttps://solscan.io/tx/${txid}`);
      } else {
        const sellResult = await executeSellFixedUsd(activeWallet, ca, parseFloat(randomSolAmount));
        ctx.reply(`🔴 [چارت | #${currentLoop} | والێت ${randomWalletIdx + 1} (${shortAddr})]\nفرۆتنا ڕێکخستنا باڵانسی ئەنجامدرا (~${sellResult.solReceived} SOL | $5-$7):\nبهایێ نوکە: ~$${currentPrice.toFixed(4)}\nhttps://solscan.io/tx/${sellResult.txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل خولێ #${currentLoop}: ${err.message || 'ترانزاکشن ڕوویدا'}`);
    }

    if (isRunning24h) {
      const nextDelay = Math.floor(Math.random() * (1320000 - 480000)) + 480000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ تەڤگەرا بهێت دێ ئەنجام دڕێت پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(executeChartStrategy, nextDelay);
    }
  };

  executeChartStrategy();
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
console.log('Chart Maker Bot is running...');
