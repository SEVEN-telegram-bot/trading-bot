const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const http = require('http');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("هەڵە: زانیارییەکانی ژینگە بوونیان نییە!");
  process.exit(1);
}

// Keep Render Alive
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Academic Balanced Market Maker Running.');
  res.end();
}).listen(PORT, () => {
  console.log(`Academic Engine Active on port ${PORT}`);
});

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

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
      console.error("هەڵە لە کلیلدا:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتێک نەدۆزرایەوە!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;
let lastUsedWalletIdx = -1;

// مێژوویا کارکرنا هەر والێتەکی ب سەربەخۆیی دا نەتیجە وەک ئێک بمینیت
const walletTradeStates = wallets.map(() => ({
  lastAction: 'SELL' // دەستپێکێ دبیتە کڕین
}));

const httpHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

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

async function executeAcademicBuy(wallet, outputMint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quoteRes = await axios.get('https://api.jup.ag/swap/v1/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: outputMint,
      amount: lamports,
      slippageBps: 200
    },
    headers: httpHeaders,
    timeout: 15000
  });

  const swapRes = await axios.post('https://api.jup.ag/swap/v1/swap', {
    quoteResponse: quoteRes.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: httpHeaders,
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

async function executeAcademicSell(wallet, inputMint, targetSolBack) {
  const targetLamports = Math.floor(targetSolBack * LAMPORTS_PER_SOL);

  const reverseQuote = await axios.get('https://api.jup.ag/swap/v1/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: inputMint,
      amount: targetLamports,
      slippageBps: 200
    },
    headers: httpHeaders,
    timeout: 15000
  });

  const tokensNeeded = reverseQuote.data.outAmount;

  const sellQuote = await axios.get('https://api.jup.ag/swap/v1/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: tokensNeeded,
      slippageBps: 250
    },
    headers: httpHeaders,
    timeout: 15000
  });

  const swapRes = await axios.post('https://api.jup.ag/swap/v1/swap', {
    quoteResponse: sellQuote.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, {
    headers: httpHeaders,
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

bot.start((ctx) => {
  let msg = `🏛️ **سیستەمێ هاوسەنگێ ئەکادیمی (Zero-Shift Market Maker)**\n\nهەژمارا والێتان: *${wallets.length}*\n(هەر والێتەک ب تنێ سەرێ خۆ بڕێڤە دبەت و چ پارە بۆ والێتەکێ دی ناچیت)\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ نوکە یێ هەر ٤ جزدانان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`کێشە د خواندنا باڵانسیدا: ${error.message}`);
  }
});

bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ بۆت یێ کار دکەت پێشتر.');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🎓 **مۆدێ ئەکادیمی یێ هاوسەنگ هاتە دەستپێکرن!**\n\n• تایبەتمەندی: هەر جزدانەک ب سەربەخۆیی کڕین و فرۆتنێن خۆ هاوسەنگ دکەت.\n• هیچ پارەیەک د ناڤبەرا جزداناندا ناچیت.\n• بارستەیا مامەلەیان: نزیکی $1.8 بۆ $4.5 ب ژمارەیێن شێوە-مرۆڤی.\n• دەمێ لڤینێ: ٢ بۆ ٦ خولەک جارەکێ ب هەڕەمەکی.\n• راوەستاندن: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەلبژارتنا والێتەکێ جودا ژ یێ پێشتر
    let randIdx;
    do {
      randIdx = Math.floor(Math.random() * wallets.length);
    } while (wallets.length > 1 && randIdx === lastUsedWalletIdx);
    lastUsedWalletIdx = randIdx;

    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      // بڕیاردانا ل سەر کڕین یان فرۆتنێ ل گۆرەی مێژوویا وی والێتی بخۆ (دا هاوسەنگ بمینیت)
      let doSell = false;
      if (walletTradeStates[randIdx].lastAction === 'BUY' && tokenBal.uiAmount > 2) {
        doSell = true;
      } else if (walletTradeStates[randIdx].lastAction === 'SELL' && solBal > 0.02 * LAMPORTS_PER_SOL) {
        doSell = false;
      } else {
        doSell = tokenBal.uiAmount > 2;
      }

      if (doSell) {
        // فرۆتنەکا هویر ل سەر چارتێ ب بڕێ (~0.015 بۆ 0.028 SOL / نزیکی $2.2 بۆ $4.2)
        const targetSol = (Math.random() * (0.028 - 0.015) + 0.015).toFixed(5);
        const res = await executeAcademicSell(activeWallet, ca, parseFloat(targetSol));
        walletTradeStates[randIdx].lastAction = 'SELL';
        ctx.reply(`🔴 [خۆلا #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتنا ئەکادیمی یا هاوسەنگ هاتە ئەنجامدان (+${res.solGained} SOL هاتە ناڤ هەمان والێت):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        // کڕینەکا مرۆڤی یا کەسک ل سەر چارتێ ب بڕێ (~0.014 بۆ 0.027 SOL / نزیکی $2.0 بۆ $4.0)
        const buySol = (Math.random() * (0.027 - 0.014) + 0.014).toFixed(5);
        const txid = await executeAcademicBuy(activeWallet, ca, parseFloat(buySol));
        walletTradeStates[randIdx].lastAction = 'BUY';
        ctx.reply(`🟢 [خۆلا #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینا مرۆڤی یا سەوزکرنا چارتێ هاتە ئەنجامدان (~${buySol} SOL ژ هەمان والێت):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری ل خولا #${currentLoop}: ${err.message || 'هەڵە لە تۆڕ'}`);
    }

    if (isRunning24h) {
      // دەمێ هەڕەمەکی یێ سروشتی: ١٢٠ هەتا ٣٦٠ چرکە (٢ بۆ ٦ خولەک)
      const nextDelay = Math.floor(Math.random() * (360000 - 120000)) + 120000;
      const mins = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ جووڵەیا بهێت (#${currentLoop + 1}) پشتی ${mins} خولەکێن دی دێ هێتە ئەنجامدان.`);
      loopTimeoutId = setTimeout(runLoop, nextDelay);
    }
  };

  runLoop();
});

bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 بۆت هاتە راوەستاندن.\nکۆیا مامەلەیان: ${tradeCount}`);
  } else {
    ctx.reply('بۆت یێ راوەستیایە.');
  }
});

bot.launch();
console.log('Academic Balanced Engine running...');
