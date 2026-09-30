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
  console.error("هەڵە: گۆڕاوەکانی ژینگە بوونیان نییە!");
  process.exit(1);
}

// Keep Render Server Awake
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Bot is active and running.');
  res.end();
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
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
      console.error("هەڵە لە خوێندنەوەی کلیل:", err.message);
    }
  }
}

if (wallets.length === 0) {
  console.error("هیچ والێتێک بار نەکراوە!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;

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

async function executeMicroBuy(wallet, outputMint, solAmount) {
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

async function executeModerateSell(wallet, inputMint, targetSolBack) {
  const targetLamports = Math.floor(targetSolBack * LAMPORTS_PER_SOL);

  const reverseQuote = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: inputMint,
      amount: targetLamports,
      slippageBps: 250
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

  return { txid, solGained: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4) };
}

bot.start((ctx) => {
  let msg = `🏛️ **بۆتی خێرای چارت و بازاڕکاری**\n\nوالێتە چالاکەکان: *${wallets.length}*\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسی ئێستای والێتەکان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await connection.getBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1} (\`${wallets[i].publicKey.toBase58().slice(0, 4)}...${wallets[i].publicKey.toBase58().slice(-4)}\`): ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`هەڵە لە وەرگرتنی باڵانس: ${error.message}`);
  }
});

bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('بۆت پێشتر کارپێکراوە.');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`⚡ **سیستەمی قەبارەی گەورە ($10) دەستی پێکرد!**\n\n• کاتی خولەکان: ١ بۆ ٣ خولەک\n• ڕێژە: ~٥٨٪ فرۆشتن (بۆ قازانجی SOL) | ~٤٢٪ کڕین\n• قەبارە: نزیکەی $8 بۆ $11 بەپێی بازاڕ\n• ڕاگرتن: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const randIdx = Math.floor(Math.random() * wallets.length);
    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await connection.getBalance(activeWallet.publicKey);
      const tokenBal = await getTokenBalance(activeWallet.publicKey, ca);

      let doSell = false;
      if (tokenBal.uiAmount > 5) {
        doSell = Math.random() < 0.58;
      }

      if (solBal < 0.05 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) {
        doSell = true;
      }

      if (doSell) {
        // فرۆشتن بە قەبارەی نزیکەی $9.5 بۆ $11 (0.065 بۆ 0.080 SOL)
        const targetSol = (Math.random() * (0.080 - 0.065) + 0.065).toFixed(5);
        const res = await executeModerateSell(activeWallet, ca, parseFloat(targetSol));
        ctx.reply(`🔴 [مامەڵەی #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆشتن سەرکەوتوو بوو (+${res.solGained} SOL):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        // کڕین بە قەبارەی نزیکەی $7.5 بۆ $8.5 (0.050 بۆ 0.058 SOL)
        const buySol = (Math.random() * (0.058 - 0.050) + 0.050).toFixed(5);
        const txid = await executeMicroBuy(activeWallet, ca, parseFloat(buySol));
        ctx.reply(`🟢 [مامەڵەی #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕین ئەنجامدرا (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری لە خولی #${currentLoop}: ${err.message || 'هەڵەیەک ڕوویدا'}`);
    }

    if (isRunning24h) {
      const nextDelay = Math.floor(Math.random() * (180000 - 60000)) + 60000;
      const mins = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ مامەڵەی داهاتوو (#${currentLoop + 1}) دوای ${mins} خولەک ئەنجام دەدرێت.`);
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
    ctx.reply(`🛑 بۆت ڕاگیرا.\nکۆی گشتی مامەڵەکان: ${tradeCount}`);
  } else {
    ctx.reply('بۆت ناچالاکە.');
  }
});

bot.launch();
console.log('Fast Chart Engine Daemon Online...');
