const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEY) {
  console.error("خەلەتی: زانیاریێن پێدڤی کێمن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
} catch (e) {
  try {
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)));
  } catch (err) {
    console.error("خەلەتی د کلیلێ دا:", err);
    process.exit(1);
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// ۱. فەنکشنا کڕینێ
async function executeBuy(outputMint, solAmount) {
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
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([wallet]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return { txid, outAmount: quoteRes.data.outAmount };
}

// ۲. فەنکشنا فرۆتنێ
async function executeSell(inputMint, rawTokenAmount) {
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
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([wallet]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return txid;
}

// فەرمانا دەستپێکێ
bot.start((ctx) => {
  ctx.reply(`سلاڤ! بۆتێ ئەکادیمی یێ ترەیدا ٢٤ دەمژمێری ئامادەیە.\n\nوالێت:\n\`${wallet.publicKey.toBase58()}\``, { parse_mode: 'Markdown' });
});

// فەرمانا باڵانسی
bot.command('balance', async (ctx) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    ctx.reply(`باڵانسێ SOL: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (error) {
    ctx.reply(`❌ خەلەتی: ${error.message}`);
  }
});

// فەرمانا ۲۴ دەمژمێری یا ئەکادیمی
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەمێ ۲۴ دەمژمێری پێشتر یێ هاتیە کارپێکرن و یێ چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🤖 **سیستەمێ ۲۴ دەمژمێری یێ ژیر دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• ستراتیژی: ئەکادیمی (بڕ و دەمێ نەدیارکری/ڕەندەم)\n• ڕاوەستان: بتنێ ب فەرمانا /stop\n\nتێبینی: هەر خولەک د ناڤبەرا ۱ بۆ ۳ خۆلەکان دا ب شێوەیەکێ سروشتی دێ کڕین و فرۆتن هێتە ئەنجامدان.`, { parse_mode: 'Markdown' });

  const executeSmartCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    try {
      // قەبارەیەکێ ڕەندەم د ناڤبەرا 0.003 بۆ 0.007 SOL
      const randomSol = (Math.random() * (0.007 - 0.003) + 0.003).toFixed(5);
      
      // ۱. کڕین
      const buyResult = await executeBuy(ca, parseFloat(randomSol));
      ctx.reply(`📈 [خولێ #${currentLoop}] کڕین (${randomSol} SOL):\nhttps://solscan.io/tx/${buyResult.txid}`);

      // ڕاوەستانا سروشتی د ناڤبەرا کڕین و فرۆتنێ (۱۵ بۆ ۲۵ چرکە)
      const waitBetween = Math.floor(Math.random() * 10000) + 15000;
      await new Promise(r => setTimeout(r, waitBetween));

      if (!isRunning24h) return;

      // ۲. فرۆتنا هەمان بڕێ تۆکەنان
      const sellTx = await executeSell(ca, buyResult.outAmount);
      ctx.reply(`📉 [خولێ #${currentLoop}] فرۆتن ب سەرکەفت:\nhttps://solscan.io/tx/${sellTx}`);

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری ل خولێ #${currentLoop}: ${err.message || 'مامەلە سەرنەکەفت، دەربازبوو بۆ خولا بهێت'}`);
    }

    if (isRunning24h) {
      // دانانا دەمەکێ ڕەندەم بۆ خولا بهێت (د ناڤبەرا ۱ خولەک بۆ ۳ خولەکان)
      const nextDelay = Math.floor(Math.random() * (180000 - 60000)) + 60000;
      loopTimeoutId = setTimeout(executeSmartCycle, nextDelay);
    }
  };

  executeSmartCycle();
});

// ڕاگرتنا یەکجارەکی
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 سیستەمێ ۲۴ دەمژمێری هاتە ڕاگرتن.\nسەرجەم مامەلەیێن دروستکراو: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پرۆسەیەکی بەردەوام کار ناکەت.');
  }
});

bot.launch();
console.log('Smart 24h Bot is running...');
