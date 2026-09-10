const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY; // دەکرێت چەند کلیل بن ب فاریزە (key1,key2,key3)
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: زانیاریێن پێدڤی کێمن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

// لودکرنا هەمی والێتان
const wallets = [];
const keysArray = PRIVATE_KEYS_RAW.split(',').map(k => k.trim()).filter(k => k.length > 0);

for (const key of keysArray) {
  try {
    wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
  } catch (e) {
    try {
      wallets.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))));
    } catch (err) {
      console.error("خەلەتی لە خواندنی کلیلەک دا هەیە:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک ب سەرکەفتی نەهاتە خواندن!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// ۱. فەنکشنا کڕینێ ب والێتا دیارکری
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

// ۲. فەنکشنا فرۆتنێ ب هەمان والێت
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
  let msg = `سلاڤ! بۆتێ چەند-والێتی (Multi-Wallet) ئامادەیە.\n\nژمارەیا والێتێن بەردەست: *${wallets.length}*\n\nلیستا ناڤونیشانان:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// فەرمانا باڵانسێ هەمی والێتان
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ والێتان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ خەلەتی ل خواندنا باڵانسی: ${error.message}`);
  }
});

// ۳. دەستپێکرنا سیستەمێ ۲۴ دەمژمێری یێ فرە-والێت
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەمێ فرە-والێت پێشتر هاتیە کارپێکرن و چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🔀 **سیستەمێ ۲۴ دەمژمێری یێ فرە-والێت دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• ژمارەیا والێتان: ${wallets.length}\n• شێواز: ل هەر خولەکێ والێتەک ب شێوەیێ ڕەندەم کار دکەت.\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeSmartCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەلبژارتنا والێتەکێ ب شێوەیەکێ ڕەندەم
    const randomIndex = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randomIndex];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      // قەبارەیەکێ کێم یێ ڕەندەم د ناڤبەرا 0.003 بۆ 0.007 SOL
      const randomSol = (Math.random() * (0.007 - 0.003) + 0.003).toFixed(5);

      // کڕین ب وێ والێتا هاتیە هەلبژارتن
      const buyResult = await executeBuy(activeWallet, ca, parseFloat(randomSol));
      ctx.reply(`📈 [خولێ #${currentLoop} | والێت ${randomIndex + 1} (${shortAddr})] کڕین (${randomSol} SOL):\nhttps://solscan.io/tx/${buyResult.txid}`);

      // ڕاوەستان بۆ ۱۰ هەتا ۲۰ چرکەیان
      const waitBetween = Math.floor(Math.random() * 10000) + 10000;
      await new Promise(r => setTimeout(r, waitBetween));

      if (!isRunning24h) return;

      // فرۆتن ب هەمان والێت
      const sellTx = await executeSell(activeWallet, ca, buyResult.outAmount);
      ctx.reply(`📉 [خولێ #${currentLoop} | والێت ${randomIndex + 1}] فرۆتن سەرکەفت:\nhttps://solscan.io/tx/${sellTx}`);

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ کێشە ل خولێ #${currentLoop} (والێت ${randomIndex + 1}): ${err.message || 'ترانزاکشن دەربازبوو'}`);
    }

    if (isRunning24h) {
      // دانانا دەمەکێ ڕەندەم بۆ خولا بهێت (د ناڤبەرا ۶۰ چرکە بۆ ۱۸۰ چرکە)
      const nextDelay = Math.floor(Math.random() * (180000 - 60000)) + 60000;
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
    ctx.reply(`🛑 سیستەم هاتە ڕاگرتن. سەرجەم خولێن ئەنجامدراو: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پڕۆسەیەکی بەردەوام کار ناکەت.');
  }
});

bot.launch();
console.log('Multi-Wallet Bot is running...');
