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

// ۱. خوێندنا کلیلان
const wallets = [];
const keysArray = PRIVATE_KEYS_RAW
  .replace(/\r?\n|\r/g, ',')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 30);

for (const key of keysArray) {
  try {
    wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
  } catch (e) {
    try {
      wallets.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))));
    } catch (err) {
      console.error("شاشی د کلیلێ دا:", err.message);
    }
  }
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

// کڕینا دروستکەرا کەندلان (~$4 - $5)
async function executeCandleBuy(wallet, outputMint, solAmount) {
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

// فرۆتنا نەرم و کەم-جیاوازی (~$5.5 - $6.5)
async function executeSoftSell(wallet, inputMint, targetSolBack) {
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

  return { txid, solGained: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4) };
}

// Start
bot.start((ctx) => {
  let msg = `🎯 **بۆتێ لڤاندنا چارتێ + فرۆتنا نەرم (Balanced Drift Bot)**\n\nوالێتێن ئامادە: *${wallets.length}*\n\nلیست:\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Balance
bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ جزدانان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ کێشە ل باڵانسی: ${error.message}`);
  }
});

// دەستپێکرنا ستراتیژیا لڤاندنا چارتێ و فرۆتنا کەم
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم پێشتر یێ دەستپێکری و چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`📊 **سیستەمێ هەڤسەنگێ لڤاندنا چارتێ کەفتە کار!**\n\n• ئارمانج: ۱. لڤاندنا بەردەوام یا چارتێ  ۲. فرۆتنا کەمەک پتر یا SEVEN بێی شکان\n• ڕێژەیا جێبەجێکرنێ: ۵۵٪ فرۆتن بەرامبەر ۴۵٪ کڕین (جیاوازییا کێم)\n• قەبارە: فرۆتن (~$5.5 - $6.5) | کڕین (~$4 - $5)\n• مەودایێ زەمەنی: ۳ بۆ ۷ خولەکان (چارت نامینیتە وەستان)\n• ڕاگرتن: ب فەرمانا /stop`, { parse_mode: 'Markdown' });

  const runBalancedCycle = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      // ۵۵٪ فرۆتن بەرامبەر ۴۵٪ کڕین (جیاوازییا کێم کو چارت تێک نەچیت)
      let doSell = false;
      if (tokenBal.uiAmount > 5) {
        doSell = Math.random() < 0.55; 
      }

      // ئەگەر جزدانەکێ SOL گەلەک کێم بوو، دەستبەجێ کەمەکێ دفروشت دا باڵانس هەبیت
      if (solBal < 0.035 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) {
        doSell = true;
      }

      if (doSell) {
        // فرۆتنا نەرم: نزیکی 0.036 تا 0.044 SOL (~$5.5 - $6.5)
        const targetSol = (Math.random() * (0.044 - 0.036) + 0.036).toFixed(5);
        const res = await executeSoftSell(activeWallet, ca, parseFloat(targetSol));
        ctx.reply(`🔴 [لڤین #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتنا نەرم هاتە کرن (+${res.solGained} SOL هاتە جزدانێ):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        // کڕینا لڤاندنا چارتێ: نزیکی 0.026 تا 0.033 SOL (~$4 - $5)
        const buySol = (Math.random() * (0.033 - 0.026) + 0.026).toFixed(5);
        const txid = await executeCandleBuy(activeWallet, ca, parseFloat(buySol));
        ctx.reply(`🟢 [لڤین #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینا کەندلا کەسک ئەنجامدرا (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی د مامەلەیا #${currentLoop} دا: ${err.message || 'خەلەتیەک ڕوویدا'}`);
    }

    if (isRunning24h) {
      // دەمێ زیندی و لڤاندنا چارتێ: ۳ بۆ ۷ خولەک (۱۸۰,۰۰۰ بۆ ۴۲۰,۰۰۰ میللی چرکە)
      const nextDelay = Math.floor(Math.random() * (420000 - 180000)) + 180000;
      const minutesWait = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ لڤینا بهێت یا چارتێ پشتی: ${minutesWait} خولەکان.`);
      loopTimeoutId = setTimeout(runBalancedCycle, nextDelay);
    }
  };

  runBalancedCycle();
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
console.log('Balanced Drift & Candle Bot is running...');
