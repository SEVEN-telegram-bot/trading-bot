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

// ۱. خوێندنا جزدانان
const wallets = [];
const keysArray = PRIVATE_KEYS_RAW.split(',').map(k => k.trim()).filter(k => k.length > 0);

for (const key of keysArray) {
  try {
    wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
  } catch (e) {
    try {
      wallets.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))));
    } catch (err) {
      console.error("شاشی د خوێندنا کلیلێ دا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک نەهاتە ناساندن!");
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

// کڕینا بچووک بۆ پاراستنا کەندلان (~$3 - $4)
async function executeMicroBuy(wallet, outputMint, solAmount) {
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

// فرۆتنا پتر بۆ کۆمکرنا SOL (~$6 - $9)
async function executeHarvestSell(wallet, inputMint, targetSolBack) {
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
      slippageBps: 250
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

  return { txid, solExtracted: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4) };
}

// فەرمانا Start
bot.start((ctx) => {
  let msg = `💰 **بۆتێ دەرهێنان و کۆمکرنا SOL (Net SOL Extraction Bot)** ئامادەیە.\n\nژمارەیا والێتان: *${wallets.length}*\n\nلیست:\n`;
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
    ctx.reply(`❌ خەلەتی: ${error.message}`);
  }
});

// کارپێکرنا سیستەمێ فرۆتنا چڕ (Sell-Biased Mode)
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم پێشتر چالاک کرایە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`💸 **مۆدێ کۆمکرنا SOL دەستپێکر!**\n\n• ئارمانج: فرۆتنا زێدەتر دا باڵانسێ SOL د جزدانان دا گەشە بکەت.\n• ڕێژەیا فرۆتن بۆ کڕینێ: ~۷۰٪ فرۆتن بەرامبەر ۳۰٪ کڕین\n• قەبارێ فرۆتنێ: ~$6 بۆ $9 (پتر ژ کڕینێ)\n• قەبارێ کڕینێ: ~$3 بۆ $4 (بچووک)\n• مەودایێ دەمی: ۵ بۆ ۱۵ خولەک ب شێوەیێ ڕەندەم\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeHarvestCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);
      const solBal = await connection.getBalance(activeWallet.publicKey);

      // بڕیاردان: ۷۰٪ فرۆتن ئەگەر تۆکەن هەبیت، بەرامبەر ۳۰٪ کڕین
      let doSell = false;
      if (tokenBal.uiAmount > 5) {
        doSell = Math.random() < 0.70; // ٧٠٪ بفرۆشێت
      }

      // ئەگەر باڵانسێ SOL کێم بیت، ب زۆری فرۆتن هەلدبژێریت
      if (solBal < 0.03 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) {
        doSell = true;
      }

      if (doSell) {
        // ۱. فرۆتن ب قەبارێ مەزنتر (0.045 تا 0.065 SOL / ~$6-$9) دا SOL بهێتە ناڤ جزدانێ
        const targetSolGain = (Math.random() * (0.065 - 0.045) + 0.045).toFixed(5);
        const sellResult = await executeHarvestSell(activeWallet, ca, parseFloat(targetSolGain));
        ctx.reply(`🔴 [کۆمکرنا SOL #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتن هاتە ئەنجامدان (+${sellResult.solExtracted} SOL کۆمکرا):\nhttps://solscan.io/tx/${sellResult.txid}`);
      } else {
        // ۲. کڕینا بچووک و پارێزەر (0.022 تا 0.028 SOL / ~$3-$4) بتنێ بۆ هێشتنا کەندلان
        const buyAmountSol = (Math.random() * (0.028 - 0.022) + 0.022).toFixed(5);
        const txid = await executeMicroBuy(activeWallet, ca, parseFloat(buyAmountSol));
        ctx.reply(`🟢 [پاراستنا کەندلێ #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینا بچووک هاتە کرن (~${buyAmountSol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل گەڕا #${currentLoop}: ${err.message || 'خەلەتیەک د جێبەجێکرنێ دا ڕوویدا'}`);
    }

    if (isRunning24h) {
      // دەمێ مەودایێ ۵ بۆ ۱۵ خولەکان ب شێوەیێ ڕەندەم (۳۰۰,۰۰۰ بۆ ۹۰۰,۰۰۰ چرکە)
      const nextDelay = Math.floor(Math.random() * (900000 - 300000)) + 300000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ تەڤگەرا بهێت (#${currentLoop + 1}) دێ هێتە ئەنجامدان پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(executeHarvestCycle, nextDelay);
    }
  };

  executeHarvestCycle();
});

// ڕاگرتن
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 سیستەم هاتە ڕاگرتن.\nسەرجەم ترانزاکشنێن ئەنجامدراو: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پرۆسەیەک کار ناکەت.');
  }
});

bot.launch();
console.log('Net SOL Extraction Bot is running...');
