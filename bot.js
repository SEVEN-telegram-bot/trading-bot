const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: فەرمانێن ژینگەهی کێمن!");
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
      console.error("خەلەتی لە کلیلێ دا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک نەهاتە ناسین!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// ۱. کڕینا ئەکادیمی
async function executeBuy(selectedWallet, outputMint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: outputMint,
      amount: lamports,
      slippageBps: 150
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

  return { txid, outAmount: quoteRes.data.outAmount };
}

// ۲. فرۆتنا ژیر و نا-هاوسەنگ
async function executeSell(selectedWallet, inputMint, rawTokenAmount) {
  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: rawTokenAmount,
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

// فەرمانا Start
bot.start((ctx) => {
  let msg = `🛡️ بۆتێ زیرەکێ بازرگانیێ یێ شاردەزا (Stealth Market Maker) ئامادەیە.\n\nژمارەیا والێتان: *${wallets.length}*\n\nلیستا ئەدرەسان:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// فەرمانا باڵانس
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ جزدانێن چالاک:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ کێشە ل پشکنینێ: ${error.message}`);
  }
});

// ۳. دەستپێکرنا مۆدێ شاردەزا و نەدیارکری
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم نوکە یێ د حالەتێ کارکرنێ دا!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🥷 **مۆدێ ئەکادیمی یێ شاردەزا دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• شێواز: نەدیارکری (Randomized Amounts & Delays)\n• تاکتیک: فرۆتنا نە-تەواو دا والێت ببنە هۆلدەرێن سروشتی.\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeSmartCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // والێتەک ب شێوەیێ ڕەندەم
    const randomIndex = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randomIndex];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      // قەبارێ ڕەندەم د ناڤبەرا 0.034 هەتا 0.043 SOL (~$5-$6)
      const randomSol = (Math.random() * (0.043 - 0.034) + 0.034).toFixed(5);

      // کڕین
      const buyResult = await executeBuy(activeWallet, ca, parseFloat(randomSol));
      ctx.reply(`📈 [خولێ #${currentLoop} | والێت ${randomIndex + 1} (${shortAddr})]\nکڕین ب سەرکەفت (~${randomSol} SOL):\nhttps://solscan.io/tx/${buyResult.txid}`);

      // ڕاگرتنا سروشتی (د ناڤبەرا ۳۵ چرکە تا ۱۲۰ چرکە)
      const waitBetween = Math.floor(Math.random() * (120000 - 35000)) + 35000;
      await new Promise(r => setTimeout(r, waitBetween));

      if (!isRunning24h) return;

      // تەکتیکا فرۆتنا نا-هاوسەنگ: ۸۲٪ بۆ ۹۶٪ دفرۆشیت دا کێمەک بمینیت و ببیتە هۆلدەر
      const sellRatio = Math.random() * (0.96 - 0.82) + 0.82;
      const tokensToSell = Math.floor(parseInt(buyResult.outAmount) * sellRatio).toString();

      // فرۆتن
      const sellTx = await executeSell(activeWallet, ca, tokensToSell);
      ctx.reply(`📉 [خولێ #${currentLoop} | والێت ${randomIndex + 1}]\nفرۆتنا بەشەکی (${(sellRatio * 100).toFixed(1)}%) ب سەرکەفت:\nhttps://solscan.io/tx/${sellTx}`);

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل خولێ #${currentLoop}: ${err.message || 'مامەلە سەرنەکەفت، بەرەڤ خولا بهێت'}`);
    }

    if (isRunning24h) {
      // دەمێ درێژ و ڕەندەم: ٤ بۆ ۱۱ خولەک (۲٤۰,۰۰۰ بۆ ۶۶۰,۰۰۰ چرکە)
      const nextDelay = Math.floor(Math.random() * (660000 - 240000)) + 240000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ خولا بهێت (#${currentLoop + 1}) دێ هێتە ئەنجامدان پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(executeSmartCycle, nextDelay);
    }
  };

  executeSmartCycle();
});

// ڕاگرتن
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 سیستەم هاتە ڕاگرتن.\nسەرجەم مامەلەیێن دروستکراو: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پڕۆسەیەک کار ناکەت.');
  }
});

bot.launch();
console.log('Academic Stealth Bot is running...');
