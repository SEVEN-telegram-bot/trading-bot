const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const http = require('http');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("شاشی: کلیل یان تۆکنێ بۆتی بەردەست نینە!");
  process.exit(1);
}

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
  res.write('Loop Bot Operational.');
  res.end();
}).listen(PORT, () => {
  console.log(`Port ${PORT} active.`);
});

const bot = new Telegraf(BOT_TOKEN);

const wallets = [];
// ڕێکخستنا زیرەکانەیا کلیلان بێی شاشیا JSON
const keysArray = PRIVATE_KEYS_RAW
  .split(/[\n,\r\s]+/)
  .map(k => k.trim())
  .filter(k => k.length > 30);

for (const key of keysArray) {
  try {
    const cleanKey = key.replace(/['"\[\]]/g, '').trim();
    wallets.push(Keypair.fromSecretKey(bs58.decode(cleanKey)));
  } catch (err) {
    console.error("شاشی د خاندنا کلیلێ دا:", err.message);
  }
}

if (wallets.length === 0) {
  console.error("چ والێت نەهاتنە دیتن!");
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let isRunning24h = false;
let loopTimeoutId = null;
let tradeCount = 0;
let currentWalletIndex = 0;

// یاسایا کڕین و دەستبەجێ فڕۆتنێ بۆ پاراستنا باڵانسی
const walletCycle = wallets.map(() => ({
  action: 'BUY'
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
      await new Promise(r => setTimeout(r, 1000));
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
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { rawAmount: '0', uiAmount: 0 };
}

async function executeBuy(wallet, outputMint, solAmount) {
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

async function executeSell(wallet, inputMint, tokenRawAmount) {
  const sellQuote = await axios.get('https://api.jup.ag/swap/v1/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: tokenRawAmount,
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
  let msg = `⚙️ **سیستەمێ کڕین و فڕۆتنا جۆت و هاوسەنگ**\n\nهژمارا والێتان: *${wallets.length}*\nهەر کڕینەک دێ ب فڕۆتنێ هێتە هاوسەنگکرن دا باڵانس کێم نەبیت.\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    let msg = `📊 **باڵانسێ نوکە یێ هەر ٤ والێتان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const b = await safeGetBalance(wallets[i].publicKey);
      msg += `والێت ${i + 1}: ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`کێشە د خواندنا باڵانسی دا: ${error.message}`);
  }
});

bot.command('start_smart', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const ca = args[1] || 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';

  if (isRunning24h) {
    return ctx.reply('⚠️ بۆت یێ کار دکەت.');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🔄 **سیستەمێ کڕین و فڕۆتنێ (تەنها بۆ چارت و ڤۆلیۆمی) دەست پێ کر!**\n\n• یاسا: کڕین ئێکسەر دێ ب فڕۆتنێ هێتە داخستن دا باڵانس کێم نەبیت.\n• ماوێ ناڤبەرا هەر خولەکێ: ٢ هەتا ٤.٥ خولەک.\n• بۆ ڕاگرتنێ: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    const activeWalletIdx = currentWalletIndex;
    currentWalletIndex = (currentWalletIndex + 1) % wallets.length;

    const activeWallet = wallets[activeWalletIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await safeGetBalance(activeWallet.publicKey);
      const tokenBal = await safeGetTokenBalance(activeWallet.publicKey, ca);

      if (walletCycle[activeWalletIdx].action === 'SELL' && tokenBal.uiAmount > 0.01) {
        const res = await executeSell(activeWallet, ca, tokenBal.rawAmount);
        walletCycle[activeWalletIdx].action = 'BUY';
        ctx.reply(`🔴 [خۆلا #${currentLoop} | والێت ${activeWalletIdx + 1} (${shortAddr})]\nفڕۆتن ئەنجامدا (+${res.solGained} SOL زڤڕیەڤە والێتێ):\nhttps://solscan.io/tx/${res.txid}`);
      } else {
        if (solBal > 0.03 * LAMPORTS_PER_SOL) {
          const buyAmount = parseFloat((Math.random() * (0.022 - 0.014) + 0.014).toFixed(5));
          const txid = await executeBuy(activeWallet, ca, buyAmount);
          walletCycle[activeWalletIdx].action = 'SELL';
          ctx.reply(`🟢 [خۆلا #${currentLoop} | والێت ${activeWalletIdx + 1} (${shortAddr})]\nکڕین ئەنجامدا (~${buyAmount} SOL د هەمان والێت دا):\nhttps://solscan.io/tx/${txid}`);
        } else {
          ctx.reply(`⚠️ والێت ${activeWalletIdx + 1} پێدڤی ب کێمەکا SOL هەیە.`);
        }
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگەهداری د خۆلا #${currentLoop}: ${err.message || 'شاشی د تۆڕێ دا'}`);
    }

    if (isRunning24h) {
      const nextDelay = Math.floor(Math.random() * (270000 - 120000)) + 120000;
      const mins = (nextDelay / 60000).toFixed(1);
      ctx.reply(`⏳ جوولەیا بهێت (#${currentLoop + 1}) پشتی ${mins} خولەکێن دی دێ هێتە ئەنجامدان.`);
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
    ctx.reply(`🛑 بۆت هاتە ڕاگرتن.\nسەرجەمێ خولان: ${tradeCount}`);
  } else {
    ctx.reply('بۆت یێ ڕاوەستیایە.');
  }
});

bot.launch();
console.log('Bot is active and running.');
