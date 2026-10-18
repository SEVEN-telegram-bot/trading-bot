const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const http = require('http');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("هەڵە: زانیارییە سەرەکییەکان بەردەست نین!");
  process.exit(1);
}

// پێڕستی باشترین نۆدە خۆڕاییە جێگیرەکان بۆ تێپەڕاندنی 429
const RPC_ENDPOINTS = [
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana'
];

let currentRpcIdx = 0;
function getActiveConnection() {
  return new Connection(RPC_ENDPOINTS[currentRpcIdx], {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
  });
}

function switchRpc() {
  currentRpcIdx = (currentRpcIdx + 1) % RPC_ENDPOINTS.length;
}

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Academic Bot active with Multi-RPC.');
  res.end();
}).listen(PORT, () => {
  console.log(`Server active on port ${PORT}`);
});

const bot = new Telegraf(BOT_TOKEN);

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

const walletTradeStates = wallets.map(() => ({
  lastAction: 'SELL'
}));

const httpHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

async function safeGetBalance(pubkey) {
  for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
    try {
      const conn = getActiveConnection();
      return await conn.getBalance(pubkey);
    } catch (err) {
      switchRpc();
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  return 0;
}

async function safeGetTokenBalance(walletPubkey, mintPubkeyStr) {
  for (let attempt = 0; attempt < RPC_ENDPOINTS.length; attempt++) {
    try {
      const conn = getActiveConnection();
      const response = await conn.getParsedTokenAccountsByOwner(walletPubkey, {
        mint: new PublicKey(mintPubkeyStr)
      });
      if (response.value.length === 0) return { rawAmount: '0', uiAmount: 0 };
      const tokenAccount = response.value[0].account.data.parsed.info.tokenAmount;
      return {
        rawAmount: tokenAccount.amount,
        uiAmount: tokenAccount.uiAmount || 0
      };
    } catch (err) {
      switchRpc();
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  return { rawAmount: '0', uiAmount: 0 };
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

  const conn = getActiveConnection();
  const txid = await conn.sendRawTransaction(tx.serialize(), {
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

  const conn = getActiveConnection();
  const txid = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return { txid, solGained: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4) };
}

bot.start((ctx) => {
  let msg = `🏛️ **سیستەمی ئەکادیمی هاوسەنگ**\nژمارەی والێتەکان: *${wallets.length}*\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسی ئێستا:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await safeGetBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1}: ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
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

  ctx.reply(`🎓 **مۆدی ئەکادیمی دژە-بلۆک (Anti-429) دەستی پێکرد!**\n• قەبارە: $1.8 بۆ $4.5 هاوسەنگ\n• کاتی خولەکان: ٢ بۆ ٥ خولەک\n• ڕاگرتن: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    let randIdx;
    do {
      randIdx = Math.floor(Math.random() * wallets.length);
    } while (wallets.length > 1 && randIdx === lastUsedWalletIdx);
    lastUsedWalletIdx = randIdx;

    const activeWallet = wallets[randIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await safeGetBalance(activeWallet.publicKey);
      const tokenBal = await safeGetTokenBalance(activeWallet.publicKey, ca);

      let doSell = false;
      if (walletTradeStates[randIdx].lastAction === 'BUY' && tokenBal.uiAmount > 2) {
        doSell = true;
      } else if (walletTradeStates[randIdx].lastAction === 'SELL' && solBal > 0.02 * LAMPORTS_PER_SOL) {
        doSell = false;
      } else {
        doSell = tokenBal.uiAmount > 2;
      }

      if (doSell) {
        const targetSol = (Math.random() * (0.028 - 0.015) + 0.015).toFixed(5);
        const res = await executeAcademicSell(activeWallet, ca, parseFloat(targetSol));
        walletTradeStates[randIdx].lastAction = 'SELL';
        ctx.reply(`🔴 [خولی #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nفرۆشتن ئەنجامدرا (+${res.solGained} SOL):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        const buySol = (Math.random() * (0.027 - 0.014) + 0.014).toFixed(5);
        const txid = await executeAcademicBuy(activeWallet, ca, parseFloat(buySol));
        walletTradeStates[randIdx].lastAction = 'BUY';
        ctx.reply(`🟢 [خولی #${currentLoop} | والێت ${randIdx + 1} (${shortAddr})]\nکڕینی سەوزکردنی چارت ئەنجامدرا (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری لە خولی #${currentLoop}: ${err.message || 'هەڵە لە تۆڕ'}`);
    }

    if (isRunning24h) {
      const nextDelay = Math.floor(Math.random() * (300000 - 120000)) + 120000;
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
console.log('Multi-RPC Academic Bot running...');
