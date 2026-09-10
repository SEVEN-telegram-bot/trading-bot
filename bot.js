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

// متغیرێن کونترۆلا خولان
let autoLoopInterval = null;
let autoLoopTimeout = null;
let loopCounter = 0;

// ۱. فەنکشنا کڕینێ
async function executeBuy(outputMint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: outputMint,
      amount: lamports,
      slippageBps: 100
    },
    timeout: 10000
  });

  const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
    quoteResponse: quoteRes.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
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

// ۲. فەنکشنا فرۆتنێ
async function executeSell(inputMint, tokenAmount) {
  const mintPubkey = new PublicKey(inputMint);
  const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
  const decimals = mintInfo.value.data.parsed.info.decimals;
  const rawAmount = Math.floor(tokenAmount * Math.pow(10, decimals));

  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: rawAmount,
      slippageBps: 150
    },
    timeout: 10000
  });

  const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
    quoteResponse: quoteRes.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
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

// فەرمانا Start
bot.start((ctx) => {
  ctx.reply(`سلاڤ! بۆتێ ئەکادیمی یێ بازرگانیێ ئامادەیە.\n\nوالێت:\n\`${wallet.publicKey.toBase58()}\``, { parse_mode: 'Markdown' });
});

// فەرمانا Balance
bot.command('balance', async (ctx) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    ctx.reply(`باڵانسێ جزدانێ: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (error) {
    ctx.reply(`❌ خەلەتی: ${error.message}`);
  }
});

// ۳. فەرمانا کارپێکرنا ئۆتۆماتیک (Auto Trading ب دەمەکێ دیارکری)
bot.command('autotrade', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 6) {
    return ctx.reply('⚠️ فۆرمات نەدروستە!\nشێواز:\n`/autotrade <CA> <SOL_Buy> <Token_Sell> <Interval_Minutes> <Total_Minutes>`\n\nنموونە:\n`/autotrade Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53 0.005 1 2 10`\n(کڕینا 0.005 SOL و فرۆتنا 1 تۆکەن هەر 2 خولەک، بۆ ماوێ 10 خولەکان)', { parse_mode: 'Markdown' });
  }

  const ca = args[1];
  const solBuyAmount = parseFloat(args[2]);
  const tokenSellAmount = parseFloat(args[3]);
  const intervalMinutes = parseFloat(args[4]);
  const totalDurationMinutes = parseFloat(args[5]);

  // پاقژکرنا پرۆسەیێن پێشتر
  if (autoLoopInterval) clearInterval(autoLoopInterval);
  if (autoLoopTimeout) clearTimeout(autoLoopTimeout);
  loopCounter = 0;

  ctx.reply(`🚀 پرۆسەیا بازرگانی یا ئۆتۆماتیک دەستپێکر!\n\n• تۆکەن: \`${ca}\`\n• قەبارێ کڕینێ: ${solBuyAmount} SOL\n• قەبارێ فرۆتنێ: ${tokenSellAmount} Tokens\n• ماوەیێ دووبارەبوونێ: هەر ${intervalMinutes} خۆلەکان جارەک\n• ماوەیێ تێستێ: ${totalDurationMinutes} خۆلەک\n\nبۆ ڕاگرتنا دەمکی بنڤیسە: /stop`, { parse_mode: 'Markdown' });

  // فەنکشنا جێبەجێکرنا ئێک خول
  const runCycle = async () => {
    loopCounter++;
    const currentCount = loopCounter;
    try {
      // ۱. کڕین
      const buyTx = await executeBuy(ca, solBuyAmount);
      ctx.reply(`🔄 [خولێ #${currentCount}] کڕین سەرکەفت:\nhttps://solscan.io/tx/${buyTx}`);

      // ڕاوەستان بۆ ۱۰ چرکەیان تا ترانزاکشنا کڕینێ پەسەند دبیت
      await new Promise(r => setTimeout(r, 10000));

      // ۲. فرۆتن
      const sellTx = await executeSell(ca, tokenSellAmount);
      ctx.reply(`✅ [خولێ #${currentCount}] فرۆتن سەرکەفت:\nhttps://solscan.io/tx/${sellTx}`);
    } catch (err) {
      ctx.reply(`⚠️ [خولێ #${currentCount}] خەلەتی: ${err.message}`);
    }
  };

  // دەستپێکرنا یەکەم خول ڕاستەوخۆ
  await runCycle();

  // خشتەکرنا دووبارەبوونێ
  autoLoopInterval = setInterval(runCycle, intervalMinutes * 60 * 1000);

  // ڕاگرتنا ئۆتۆماتیک پشتی تەمامبوونا ماوەیێ دیارکری
  autoLoopTimeout = setTimeout(() => {
    if (autoLoopInterval) {
      clearInterval(autoLoopInterval);
      autoLoopInterval = null;
      ctx.reply(`🏁 تێست ب سەرکەفتی ب دووماهی هات!\nماوەیێ دیارکری (${totalDurationMinutes} خولەک) تمام بوو. سەرجەم خولێن ئەنجامدراو: ${loopCounter}`);
    }
  }, totalDurationMinutes * 60 * 1000);
});

// ٤. فەرمانا ڕاگرتنا پێشوەخت
bot.command('stop', (ctx) => {
  if (autoLoopInterval || autoLoopTimeout) {
    clearInterval(autoLoopInterval);
    clearTimeout(autoLoopTimeout);
    autoLoopInterval = null;
    autoLoopTimeout = null;
    ctx.reply(`🛑 پڕۆسە هاتە ڕاگرتن. کۆی گشتی خولێن کارپێکراو: ${loopCounter}`);
  } else {
    ctx.reply('هیچ پڕۆسەیەکی چالاک نینە.');
  }
});

bot.launch();
console.log('Bot is running...');
