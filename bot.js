const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
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

// ۱. لۆدکرنا جزدانان
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
  console.error("هیچ والێتەک نەهاتە خوێندن!");
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

// کڕینا دروستکەرا کەندلێن کەسک (Green Candlemaker)
async function executeCandleBuy(wallet, outputMint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: outputMint,
      amount: lamports,
      slippageBps: 250
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

  const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapBuf);
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return txid;
}

// فرۆتنا بچووک و نەرم دا چارتی نەشکێنیت (Micro Sell)
async function executeMicroSell(wallet, inputMint, targetSolBack) {
  const targetLamports = Math.floor(targetSolBack * LAMPORTS_PER_SOL);

  const reverseQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: inputMint,
      amount: targetLamports,
      slippageBps: 200
    },
    timeout: 15000
  });

  const tokensNeeded = reverseQuote.data.outAmount;

  const sellQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: tokensNeeded,
      slippageBps: 300
    },
    timeout: 15000
  });

  const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
    quoteResponse: sellQuote.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapBuf);
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return txid;
}

// فەرمانا Start
bot.start((ctx) => {
  let msg = `🕯️ **بۆتێ لڤاندنا چارتی و چێکرنا ترێندی (Chart Action Bot)**\n\nژمارەیا والێتان: *${wallets.length}*\n\nلیست:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// فەرمانا Balance
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

// ۲. دەستپێکرنا مۆدێ لڤاندنا چارتی (Price Action Mode)
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ بۆت پێشتر یێ هاتیە هەلبژارتن و کار دکەت!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🚀 **مۆدێ لڤاندنا چارتێ کەفتە کار!**\n\n• ئارمانج: دروستکرنا کەندلێن کەسک و بلینداکرنا چارتی\n• قەبارێ کڕینێ: $4 بۆ $7 دا چارت حەرەکەتێ بکەت\n• فرۆتن: بتنێ فرۆتنێن گەلەک بچووک ($2) بۆ پێدانا SOL بێ تێکدانا چارتێ\n• مەودایێ چاڤەڕێبوونێ: ۲ بۆ ۶ خولەکان ب شێوەیێ ناڕێک\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeChartWave = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      // لۆژیکا لڤاندنا چارتێ:
      // بۆت زۆربەیا دەمان (۸۰٪) تەنێ دکڕیت دا چارت بەرەڤ سەری بچیت.
      // تەنێ ۲۰٪ دەمان فرۆتنەکا چکۆلە دکەت دا جزدان خالی نەبیت.
      let isBuy = true;
      if (tokenBal.uiAmount > 10 && Math.random() < 0.20) {
        isBuy = false;
      }

      if (solBal < 0.03 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 10) {
        isBuy = false;
      }

      if (isBuy) {
        // کڕینا $4 بۆ $7 (کەندلا کەسک)
        const buyAmountSol = (Math.random() * (0.046 - 0.028) + 0.028).toFixed(5);
        const txid = await executeCandleBuy(activeWallet, ca, parseFloat(buyAmountSol));
        ctx.reply(`🟢 [لڤاندنا چارتێ #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینا کەندلا کەسک ئەنجامدرا (~${buyAmountSol} SOL):\nhttps://solscan.io/tx/${txid}`);
      } else {
        // فرۆتنا چکۆلە ($2-$3) دا چارت نەکەڤیتە خوارێ
        const sellAmountSol = (Math.random() * (0.020 - 0.014) + 0.014).toFixed(5);
        const txid = await executeMicroSell(activeWallet, ca, parseFloat(sellAmountSol));
        ctx.reply(`🔴 [لڤاندنا چارتێ #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتنا نەرم (Micro Sell) ئەنجامدرا (~${sellAmountSol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل گەڕا #${currentLoop}: ${err.message || 'خەلەتیەک د تۆڕێ دا ڕوویدا'}`);
    }

    if (isRunning24h) {
      // دەمێ دروستکرنا کەندلان: ۲ بۆ ۶ خولەک دا چارت لڤینێ بکەت (۱۲۰,۰۰۰ بۆ ۳۶۰,۰۰۰ میلی چرکە)
      const nextDelay = Math.floor(Math.random() * (360000 - 120000)) + 120000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ لڤینا بهێت یا چارتێ دێ دەستپێکەت پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(executeChartWave, nextDelay);
    }
  };

  executeChartWave();
});

// ڕاگرتن
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 لڤاندنا چارتێ هاتە ڕاگرتن.\nسەرجەم ترانزاکشن: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پرۆسەیەک کار ناکەت.');
  }
});

bot.launch();
console.log('Chart Action Mover Bot is running...');
