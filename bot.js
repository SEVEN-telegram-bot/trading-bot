const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: زانیاریێن پێدڤی کێمن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

// ۱. لودکرنا هەمی والێتان
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

// ۲. فەنکشنا کڕینێ
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

// ۳. فەنکشنا فرۆتنێ
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

// فەرمانا دەستپێکێ
bot.start((ctx) => {
  let msg = `سلاڤ! بۆتێ ئەکادیمی یێ پێشکەفتی (Multi-Wallet) ئامادەیە.\n\nژمارەیا والێتان: *${wallets.length}*\n\nلیستا والێتان:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// فەرمانا باڵانسی
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ والێتان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ خەلەتی: ${error.message}`);
  }
});

// سیستەمێ ۲۴ دەمژمێری یێ ڕێکخستی (٥-٦ دۆلار + دەمێ درێژتر)
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەمێ ۲۴ دەمژمێری چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`⚙️ **سیستەمێ ئەکادیمی یێ نوو دەستپێکر!**\n\n• قەبارێ کڕینێ: د ناڤبەرا ~٥ بۆ ٦ دۆلار (0.035 بۆ 0.042 SOL)\n• ماوەیێ د ناڤبەرا ترەیداندا: ڕەندەم د ناڤبەرا **٥ بۆ ۱۲ خولەکان**\n• والێت: سووڕان ب شێوەیێ ڕەندەم ل سەر ${wallets.length} والێتان\n• ڕاوەستان: بتنێ ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeSmartCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەلبژارتنا والێتەکێ ب شێوەیێ ڕەندەم
    const randomIndex = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randomIndex];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      // قەبارێ ٥ بۆ ٦ دۆلار ب SOL (د ناڤبەرا 0.035 هەتا 0.042 SOL)
      const randomSol = (Math.random() * (0.042 - 0.035) + 0.035).toFixed(5);

      // ۱. کڕین
      const buyResult = await executeBuy(activeWallet, ca, parseFloat(randomSol));
      ctx.reply(`📈 [خولێ #${currentLoop} | والێت ${randomIndex + 1} (${shortAddr})] کڕین ئەنجامدرا (~$5-$6 / ${randomSol} SOL):\nhttps://solscan.io/tx/${buyResult.txid}`);

      // ڕاوەستانا کورت د ناڤبەرا کڕین و فرۆتنێ (۲۰ بۆ ٤۰ چرکە)
      const waitBetween = Math.floor(Math.random() * 20000) + 20000;
      await new Promise(r => setTimeout(r, waitBetween));

      if (!isRunning24h) return;

      // ۲. فرۆتنا هەمان بڕ
      const sellTx = await executeSell(activeWallet, ca, buyResult.outAmount);
      ctx.reply(`📉 [خولێ #${currentLoop} | والێت ${randomIndex + 1}] فرۆتن سەرکەفت:\nhttps://solscan.io/tx/${sellTx}`);

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ کێشە ل خولێ #${currentLoop} (والێت ${randomIndex + 1}): ${err.message || 'مامەلە دەربازبوو'}`);
    }

    if (isRunning24h) {
      // دەمێ درێژکراو د ناڤبەرا مامەلاندا: ۵ بۆ ۱۲ خولەک (۳۰۰,۰۰۰ بۆ ۷۲۰,۰۰۰ میللی چرکە)
      const nextDelay = Math.floor(Math.random() * (720000 - 300000)) + 300000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ خولا بهێت (#${currentLoop + 1}) دێ دەستپێکەت پشتی: ${minutesWait} خولەکان.`);
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
    ctx.reply(`🛑 سیستەمێ ترەیدا ئەکادیمی هاتە ڕاگرتن.\nسەرجەم مامەلەیێن ئەنجامدراو: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پرۆسەیەکی بەردەوام کار ناکەت.');
  }
});

bot.launch();
console.log('Multi-Wallet Bot with 5-12 min delays is running...');
