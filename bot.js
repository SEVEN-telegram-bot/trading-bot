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
  res.write('Human Stealth Engine active.');
  res.end();
}).listen(PORT, () => {
  console.log(`Stealth daemon active on port ${PORT}`);
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

async function executeHumanBuy(wallet, outputMint, solAmount) {
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

async function executeHumanSell(wallet, inputMint, targetSolBack) {
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

bot.start((ctx) => {
  let msg = `👤 **سیستەمی بازاڕکاری بە شێوازی مرۆڤی ڕاستەقینە**\n\nوالێتەکان: *${wallets.length}*\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسی خێرا:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`کێشە لە خوێندنەوەی باڵانس: ${error.message}`);
  }
});

bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ بۆت پێشتر کارپێکراوە.');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`👤 **مۆدی مامەڵەی تەواو سروشتی دەستی پێکرد!**\n\n• شێواز: قەبارەی هەڕەمەکی و کاتی نادیار (وەک کڕیاری ڕاستەقینە)\n• قەبارە: لە نێوان ~$2.5 بۆ ~$7.8 هەڕەمەکی\n• کاتەکان: ١.٥ بۆ ٥.٥ خولەک\n• ڕاگرتن: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // هەڵبژاردنی والێتێک کە لە خولی پێشوو بەکارنەهاتبێت تا وەک دوو کەسی جیاواز دەرکەوێت
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

      // بڕیار لەسەر کڕین یان فرۆشتن بە ڕێژەی ٥٣٪ فرۆشتن / ٤٧٪ کڕین
      let doSell = false;
      if (tokenBal.uiAmount > 3) {
        doSell = Math.random() < 0.53;
      }

      if (solBal < 0.03 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 3) {
        doSell = true;
      }

      if (doSell) {
        // فرۆشتنی هەڕەمەکی بە بڕێکی زۆر سروشتی (0.022 بۆ 0.048 SOL / نزیکەی $3.3 بۆ $7.2)
        const targetSol = (Math.random() * (0.048 - 0.022) + 0.022).toFixed(5);
        const res = await executeHumanSell(activeWallet, ca, parseFloat(targetSol));
        ctx.reply(`🔴 [مامەڵە #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆشتنی ئاسایی ئەنجامدرا (+${res.solGained} SOL):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        // کڕینی هەڕەمەکی وەک کەسێکی تازە (0.018 بۆ 0.042 SOL / نزیکەی $2.7 بۆ $6.3)
        const buySol = (Math.random() * (0.042 - 0.018) + 0.018).toFixed(5);
        const txid = await executeHumanBuy(activeWallet, ca, parseFloat(buySol));
        ctx.reply(`🟢 [مامەڵە #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینی سەوزکردنی چارت (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری لە خولی #${currentLoop}: ${err.message || 'هەڵە لە تۆڕ'}`);
    }

    if (isRunning24h) {
      // کاتی هەڕەمەکی لە نێوان ٩٠ چرکە بۆ ٣٣٠ چرکە (١.٥ بۆ ٥.٥ خولەک)
      const nextDelay = Math.floor(Math.random() * (330000 - 90000)) + 90000;
      const mins = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ جووڵەی داهاتوو (#${currentLoop + 1}) دوای ${mins} خولەک ئەنجام دەدرێت.`);
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
    ctx.reply(`🛑 بۆت ڕاگیرا.\nکۆی گشتی: ${tradeCount}`);
  } else {
    ctx.reply('بۆت ناچالاکە.');
  }
});

bot.launch();
console.log('Human Stealth Bot running...');
