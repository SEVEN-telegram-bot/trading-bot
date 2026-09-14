const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("خەلەتی: زانیاریێن ژینگەهی کێمن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

// چارەسەرییا بنەڕەتی یا خوێندنا کلیلان (چ بە فاریزە، بۆشایی یان دێڕا نوو بیت)
const wallets = [];
const keysArray = PRIVATE_KEYS_RAW
  .replace(/\r?\n|\r/g, ',') // گۆڕینا هەمی دێڕێن نوو بۆ فاریزە
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 30); // پاککرنەوە ژ هەر دەقەکێ بەتاڵ

for (const key of keysArray) {
  try {
    wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
  } catch (e) {
    try {
      wallets.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key))));
    } catch (err) {
      console.error("خەلەتی ل کلیلێ دا:", err.message);
    }
  }
}

console.log(`سەرجەم والێتێن هاتینە خوێندن: ${wallets.length}`);

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

// کڕین
async function executeBuy(wallet, outputMint, solAmount) {
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

// فرۆتن
async function executeSell(wallet, inputMint, targetSolBack) {
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
  let msg = `🏛️ **سیستەمێ ژیرێ فرە-والێت**\n\nوالێتێن هاتینە ناسین: *${wallets.length}*\n\nلیست:\n`;
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
    ctx.reply(`❌ کێشە ل باڵانسی: ${error.message}`);
  }
});

// دەستپێکرن
bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ سیستەم پێشتر یێ چالاکە!');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🚀 **سیستەم دەستپێکر!**\n\n• ژمارەیا والێتان: ${wallets.length}\n• مەودایێ دەمی: ۵ بۆ ۱۵ خولەک\n• ڕاگرتن: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      let doSell = false;
      if (tokenBal.uiAmount > 5) {
        doSell = Math.random() < 0.65;
      }
      if (solBal < 0.035 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) {
        doSell = true;
      }

      if (doSell) {
        const targetSol = (Math.random() * (0.055 - 0.035) + 0.035).toFixed(5);
        const res = await executeSell(activeWallet, ca, parseFloat(targetSol));
        ctx.reply(`🔴 [مامەلە #${tradeCount} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆتن ئەنجامدرا (+${res.solBack} SOL):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        const buySol = (Math.random() * (0.035 - 0.022) + 0.022).toFixed(5);
        const txid = await executeBuy(activeWallet, ca, parseFloat(buySol));
        ctx.reply(`🟢 [مامەلە #${tradeCount} | والێت ${randIdx + 1} (${shortAddr})]\nکڕین ئەنجامدرا (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }
    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ تێبینی ل مامەلە #${tradeCount}: ${err.message || 'خەلەتی'}`);
    }

    if (isRunning24h) {
      const nextDelay = Math.floor(Math.random() * (900000 - 300000)) + 300000;
      const mins = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ تەڤگەرا بهێت پشتی: ${mins} خولەکان.`);
      loopTimeoutId = setTimeout(runLoop, nextDelay);
    }
  };

  runLoop();
});

// ڕاگرتن
bot.command('stop', (ctx) => {
  if (isRunning24h) {
    isRunning24h = false;
    if (loopTimeoutId) clearTimeout(loopTimeoutId);
    loopTimeoutId = null;
    ctx.reply(`🛑 سیستەم هاتە ڕاگرتن.\nسەرجەم ترانزاکشن: ${tradeCount}`);
  } else {
    ctx.reply('هیچ پرۆسەیەک کار ناکەت.');
  }
});

bot.launch();
console.log('Bot running...');
