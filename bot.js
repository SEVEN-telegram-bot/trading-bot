const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: ڕێکخستنێن ژینگەهی کێمن!");
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
      console.error("خەلەتی د ناساندنا کلیلێ دا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتەک نەهاتە خوێندن!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ئاستێن ستراتیژیک یێن چارتی
const SUPPORT_LEVEL = 0.2150;     // هێلا پاراستنێ: تنێ کڕین بۆ بلندکرنەوەیا چارتی
const RESISTANCE_LEVEL = 0.2350;  // هێلا بەربەستێ: فرۆتنا قازانجێن بچووک دا دووبارە بچیتە بنێ ڕەنجێ

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

// خواندنا بهایێ زەندوویێ تۆکەنێ ژ پرۆتۆکۆلی ب USDC
async function fetchOnChainPrice(tokenMint) {
  try {
    const res = await axios.get('https://public.jupiterapi.com/quote', {
      params: {
        inputMint: tokenMint,
        outputMint: USDC_MINT,
        amount: 1000000, // 1 Unit
        slippageBps: 100
      },
      timeout: 10000
    });
    return parseFloat(res.data.outAmount) / 1000000;
  } catch (err) {
    return 0.2200; // نرخی بنەڕەت ئەگەر ڕایەڵە سست بوو
  }
}

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

// کڕینا ئەکادیمی (Jupiter Dynamic Slippage)
async function executeSmartBuy(wallet, outputMint, solAmount) {
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

  const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapBuf);
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return txid;
}

// فرۆتنا پارێزراو ب قەبارێ $5 تا $7
async function executeSmartSell(wallet, inputMint, targetSolAmount) {
  const targetLamports = Math.floor(targetSolAmount * LAMPORTS_PER_SOL);

  // دۆزینەوەی دەقیقی ژمارەیا تۆکەنێ هاوتەریب دگەل وی قەبارەی
  const reverseQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: inputMint,
      amount: targetLamports,
      slippageBps: 150
    },
    timeout: 15000
  });

  const tokensNeeded = reverseQuote.data.outAmount;

  const sellQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: tokensNeeded,
      slippageBps: 200
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

// Start
bot.start((ctx) => {
  let msg = `🏛️ **بۆتێ پرۆتۆکۆلی یێ بازرگانییا چارتی (Academic AMM Market Maker)**\n\nوالێتێن چالاک: *${wallets.length}*\n\nلیست:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Balance
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ ڕاستەوخۆ یێ جزدانان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ شاشی: ${error.message}`);
  }
});

// سیستەمێ ۲۴ دەمژمێری یێ شیکاریا ژیر
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم نوکە کار دکەت و بەردەوامە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`⚡ **سیستەمێ ئەکادیمی یێ پرۆتۆکۆلان کەفتە کار!**\n\n• نیشانا پشتەڤانیێ (Support): $${SUPPORT_LEVEL}\n• نیشانا بەربەستێ (Resistance): $${RESISTANCE_LEVEL}\n• قەبارێ هەر تەڤگەرەکێ: $5 بۆ $7 ب شێوەیێ ڕەندەم\n• مەودایێ زەمەنی: ۸ بۆ ۲۲ خولەک د ناڤبەرا هەر کارەکی دا\n• ڕاگرتن: /stop`, { parse_mode: 'Markdown' });

  const runProtocolCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەڵبژاردنی جزدان ب شێوەیێ ڕەندەم
    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const livePrice = await fetchOnChainPrice(ca);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);
      const solBal = await connection.getBalance(activeWallet.publicKey);

      // لۆژیکا ئەکادیمی یا شیکاریا چارتێ
      let decision = 'BUY';

      if (livePrice <= SUPPORT_LEVEL) {
        // ئەگەر نرخ شۆڕ بوو: کڕین ئەنجام ددەت دا چارتی ڕابگریت (Support Defense)
        decision = 'BUY';
      } else if (livePrice >= RESISTANCE_LEVEL && tokenBal.uiAmount > 5) {
        // ئەگەر نرخ بلند بوو: فرۆتنا ڕێکخراو ب قەبارێ دیارکری دا چارتی بنەجێ بکەت
        decision = 'SELL';
      } else {
        // د ناڤبەرا ئاستەکان دا: ٦٥٪ کڕین، ۳٥٪ فرۆتن بۆ پاراستنا هێلا کەسک
        decision = (tokenBal.uiAmount > 5 && solBal > 0.04 * LAMPORTS_PER_SOL && Math.random() < 0.35) ? 'SELL' : 'BUY';
      }

      // ژمارەیا ناڕێک و ئەکادیمی یێ $5-$7
      const randomSol = (Math.random() * (0.048 - 0.035) + 0.035).toFixed(5);

      if (decision === 'BUY') {
        const txid = await executeSmartBuy(activeWallet, ca, parseFloat(randomSol));
        ctx.reply(`🟢 [مامەلە #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینا پاراستنا چارتی ئەنجامدرا (~${randomSol} SOL | $5-$7):\nنرخێ زەندووی: ~$${livePrice.toFixed(4)}\nhttps://solscan.io/tx/${txid}`);
      } else {
        const result = await executeSmartSell(activeWallet, ca, parseFloat(randomSol));
        ctx.reply(`🔴 [مامەلە #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتنا ڕێکخستنا باڵانسی ئەنجامدرا (~${result.solBack} SOL | $5-$7):\nنرخێ زەندووی: ~$${livePrice.toFixed(4)}\nhttps://solscan.io/tx/${result.txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل مامەلەیا #${currentLoop}: ${err.message || 'خەلەتیەک د تۆڕێ دا ڕوویدا'}`);
    }

    if (isRunning24h) {
      // دەمێ مرۆڤانە: ۸ بۆ ۲۲ خولەک (٤٨٠,٠٠٠ بۆ ١,٣٢٠,٠٠٠ میللی چرکە)
      const nextDelay = Math.floor(Math.random() * (1320000 - 480000)) + 480000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ تەڤگەرا بهێت (#${currentLoop + 1}) دێ هێتە ئەنجامدان پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(runProtocolCycle, nextDelay);
    }
  };

  runProtocolCycle();
});

// Stop
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 سیستەمێ پرۆتۆکۆلی هاتە ڕاگرتن.\nسەرجەم تەڤگەرێن ئەنجامدراو: ${tradeCount}`);
  } else {
    ctx.reply('سیستەم یێ چالاک نینە.');
  }
});

bot.launch();
console.log('Academic Protocol MM Bot is online...');
