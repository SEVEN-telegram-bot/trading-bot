const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: زانیاریێن پێدڤی د ژینگەهێ دا کێمن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

// ۱. بارکرن و پشکنینا والێتان
const wallets = [];
const keysArray = PRIVATE_KEYS_RAW.split(',').map(k => k.trim()).filter(k => k.length > 0);

for (const key of keysArray) {
  try {
    wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
  } catch (e) {
    try {
      wallets.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))));
    } catch (err) {
      console.error("شاشی د خوێندنا کلیلەکێ دا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک ب سەرکەفتی نەهاتە بارکرن!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// پشکنینا هووربین یا باڵانسێ تۆکەنێ
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

// کڕینا ئەکادیمی ب Priority Fee یا داینامیک
async function executeStealthBuy(wallet, outputMint, solAmount) {
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

// فرۆتنا ژیرانە بۆ کێشانا قازانجی و پاراستنا SOL
async function executeStrategicSell(wallet, inputMint, targetSolBack) {
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

  return { txid, solBack: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4) };
}

// فەرمانا Start
bot.start((ctx) => {
  let msg = `🏛️ **سیستەمێ ئەکادیمی یێ بەرژەوەندیا پڕۆژەی (Protocol Value MM)**\n\nوالێتێن چالاک: *${wallets.length}*\n\nلیست:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// فەرمانا Balance
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ جزدانێن فەرمی:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ کێشە ل پشکنینێ: ${error.message}`);
  }
});

// ۲. دەستپێکرنا مۆدێ قازانج و پاراستنا پڕۆژەی
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ بۆت پێشتر یێ هاتیە هەلبژارتن و یێ چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`💎 **مۆدێ ئەکادیمی یێ گەشەیا دارایی دەستپێکر!**\n\n• تۆکەن: \`${ca}\`\n• ئارمانج: گەشەپێدانا باڵانسێ SOL و پاراستنا کەندلێن چارتی\n• فەلسەفە: بەرزکرنەوە ب کڕینێن بچووک + قازانج وەرگرتن ب فرۆتنا کەمتر زیانبەخش\n• دەمێ چاڤەڕێبوونێ: ۶ بۆ ۱۸ خولەکان ب شێوەیێ ناڕێک\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const executeProjectCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەڵبژاردنا والێتەکێ ب شێوەیێ ڕەندەم
    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      // لۆژیکا بەرژەوەندیا دارایی:
      // ئەگەر تۆکەن هەبیت و باڵانسێ SOL بگەهیتە ژێر 0.04 SOL، فرۆتن دکەت دا جزدان هەمیشە تێر SOL بمینیت.
      // ئەگەر باڵانس باش بیت، ۵٥٪ فرۆتنا قازانج دکەت بەرامبەر ٤٥٪ کڕین بۆ پاراستنا کەندلا کەسک.
      let doSell = false;
      if (tokenBal.uiAmount > 5) {
        doSell = Math.random() < 0.55;
      }

      if (solBal < 0.035 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) {
        doSell = true;
      }

      if (doSell) {
        // فرۆتن بۆ بەدەستهێنانا SOL ($5 تا $8)
        const targetSolExtract = (Math.random() * (0.055 - 0.036) + 0.036).toFixed(5);
        const sellResult = await executeStrategicSell(activeWallet, ca, parseFloat(targetSolExtract));
        ctx.reply(`🔴 [گەشەیا SOL #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتنا قازانجی ئەنجامدرا (+${sellResult.solBack} SOL هاتە جزدانێ):\nhttps://solscan.io/tx/${sellResult.txid}`);
      } else {
        // کڕینا بچووک و سەوز ($3 تا $5 / ~0.022 - 0.035 SOL)
        const buySolAmount = (Math.random() * (0.035 - 0.022) + 0.022).toFixed(5);
        const txid = await executeStealthBuy(activeWallet, ca, parseFloat(buySolAmount));
        ctx.reply(`🟢 [کەندلا کەسک #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینا پشتەڤانیێ ئەنجامدرا (~${buySolAmount} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل گەڕا #${currentLoop}: ${err.message || 'خەلەتیەک ڕوویدا'}`);
    }

    if (isRunning24h) {
      // دەمێ ئەکادیمی: ۶ بۆ ۱۸ خولەک (۳۶۰,۰۰۰ بۆ ۱,۰۸۰,۰۰۰ میلی چرکە)
      const nextDelay = Math.floor(Math.random() * (1080000 - 360000)) + 360000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ خولا بهێت (#${currentLoop + 1}) دێ هێتە ئەنجامدان پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(executeProjectCycle, nextDelay);
    }
  };

  executeProjectCycle();
});

// فەرمانا ڕاگرتنێ
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 پرۆسە هاتە ڕاگرتن.\nسەرجەم ترانزاکشن: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پرۆسەیەک کار ناکەت.');
  }
});

bot.launch();
console.log('Project Treasury & Stealth MM Bot is online...');
