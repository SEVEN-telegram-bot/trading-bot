const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
let bs58 = require('bs58');
if (bs58.default) bs58 = bs58.default;

const axios = require('axios');
const http = require('http');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEY;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !PRIVATE_KEYS_RAW) {
  console.error("هەڵە: کلیلەکان یان تۆکنی تێلێگرام دیارینەکراون!");
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

// سێرڤەری ناوەکی بۆ مانەوەی خزمەتگوزاری بە چالاکی
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('50/50 Chart Maker Engine Running.');
  res.end();
}).listen(PORT, () => {
  console.log(`Daemon active on port ${PORT}`);
});

const bot = new Telegraf(BOT_TOKEN);

const wallets = [];
const keysArray = PRIVATE_KEYS_RAW
  .split(/[\n,\r\s]+/)
  .map(k => k.trim())
  .filter(k => k.length > 30);

for (const key of keysArray) {
  try {
    const cleanKey = key.replace(/['"\[\]]/g, '').trim();
    wallets.push(Keypair.fromSecretKey(bs58.decode(cleanKey)));
  } catch (err) {
    console.error("هەڵە لە کلیلدا:", err.message);
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
let currentWalletIndex = 0;

// پشکنینی باڵانسی SOL
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

// پشکنینی باڵانسی تۆکنی SEVEN
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

// کڕینی بڕێکی کەم (تەنها بۆ سەوزکردنی چارت)
async function executeBuy(wallet, outputMint, solAmount) {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quoteRes = await axios.get('https://api.jup.ag/swap/v1/quote', {
    params: {
      inputMint: SOL_MINT,
      outputMint: outputMint,
      amount: lamports,
      slippageBps: 200
    },
    timeout: 15000
  });

  const swapRes = await axios.post('https://api.jup.ag/swap/v1/swap', {
    quoteResponse: quoteRes.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, { timeout: 15000 });

  const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapBuf);
  tx.sign([wallet]);

  const conn = getActiveConnection();
  return await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });
}

// فرۆشتنی بەشێکی کەم لە SEVEN (تەنها بۆ سوورکردنی چارت و هێشتنەوەی SOL)
async function executeSell(wallet, inputMint, tokenRawAmount) {
  const sellQuote = await axios.get('https://api.jup.ag/swap/v1/quote', {
    params: {
      inputMint: inputMint,
      outputMint: SOL_MINT,
      amount: tokenRawAmount,
      slippageBps: 250
    },
    timeout: 15000
  });

  const swapRes = await axios.post('https://api.jup.ag/swap/v1/swap', {
    quoteResponse: sellQuote.data,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }, { timeout: 15000 });

  const swapBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapBuf);
  tx.sign([wallet]);

  const conn = getActiveConnection();
  const txid = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });

  return {
    txid,
    solGained: (Number(sellQuote.data.outAmount) / LAMPORTS_PER_SOL).toFixed(4)
  };
}

bot.start((ctx) => {
  let msg = `⚙️ **بۆتی هاوسەنگی چارت (نیوە بە نیوە)**\n\nوالێتە چالاکەکان: *${wallets.length}*\nتێبینی: هەر والێتێک کەمێک دەکڕێت و کەمێک دەفرۆشێت تا چارت نەوەستێت و باڵانس بە یەکسانی بمێنێتەوە.\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    const ca = 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';
    let msg = `📊 **باڵانسی ئێستای ٤ والێتەکە:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const bSol = await safeGetBalance(wallets[i].publicKey);
      const bToken = await safeGetTokenBalance(wallets[i].publicKey, ca);
      msg += `والێت ${i + 1}:\n• SOL: ${(bSol / LAMPORTS_PER_SOL).toFixed(4)}\n• SEVEN: ${bToken.uiAmount.toFixed(2)}\n\n`;
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
    return ctx.reply('⚠️ بۆتەکە پێشتر چالاک کراوە.');
  }

  isRunning24h = true;
  tradeCount = 0;

  ctx.reply(`🚀 **سیستەمی جوڵاندنی چارت (هاوسەنگی ٥٠٪ بە ٥٠٪) دەستی پێکرد!**\n\n• تایبەتمەندی: نە SOL تەواو دەبێت نە SEVEN دەفرۆشرێت بە تەواوی.\n• بەردەوام کڕین و فرۆشتنی ورد ئەنجام دەدرێت بۆ جوڵاندنی چارت.\n• ماوەی نێوان ئۆردەرەکان: ١.٥ بۆ ٣.٥ خولەک.\n• ڕاگرتن: /stop`);

  const runLoop = async () => {
    if (!isRunning24h) return;

    tradeCount++;
    const currentLoop = tradeCount;

    // دیاریکردنی والێت بەپێی نۆرە
    const activeWalletIdx = currentWalletIndex;
    currentWalletIndex = (currentWalletIndex + 1) % wallets.length;

    const activeWallet = wallets[activeWalletIdx];
    const shortAddr = `${activeWallet.publicKey.toBase58().slice(0, 4)}...${activeWallet.publicKey.toBase58().slice(-4)}`;

    try {
      const solBal = await safeGetBalance(activeWallet.publicKey);
      const tokenBal = await safeGetTokenBalance(activeWallet.publicKey, ca);

      // بڕیار لەسەر کڕین یان فرۆشتن بە شێوەیەک باڵانس بە ٥٠/٥٠ بمێنێتەوە
      let action = 'BUY';
      if (tokenBal.uiAmount > 5 && Math.random() > 0.5) {
        action = 'SELL';
      }

      if (action === 'BUY' && solBal > 0.02 * LAMPORTS_PER_SOL) {
        // بڕێکی کەم دەکڕێت (نزیکەی 1.5 بۆ 2.5 دۆلار) تەنها بۆ سەوزکردنی چارت
        const buySol = parseFloat((Math.random() * (0.015 - 0.008) + 0.008).toFixed(4));
        const txid = await executeBuy(activeWallet, ca, buySol);
        ctx.reply(`🟢 [خولی #${currentLoop} | والێت ${activeWalletIdx + 1} (${shortAddr})]\nکڕینی سەوزکردنی چارت ئەنجامدرا (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      } else if (tokenBal.uiAmount > 2) {
        // فرۆشتنی تەنها بەشێکی کەم (نزیکەی 10% بۆ 20% لە تۆکنەکانی ناو هەمان والێت) بۆ هاوسەنگکردن
        const sellFraction = (Math.random() * (0.20 - 0.10) + 0.10);
        const sellRaw = Math.floor(Number(tokenBal.rawAmount) * sellFraction).toString();
        const res = await executeSell(activeWallet, ca, sellRaw);
        ctx.reply(`🔴 [خولی #${currentLoop} | والێت ${activeWalletIdx + 1} (${shortAddr})]\nفرۆشتنی چارت ئەنجامدرا (+${res.solGained} SOL گەڕایەوە):\nhttps://solscan.io/tx/${res.txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری لە خولی #${currentLoop}: ${err.message || 'هەڵەی پەیوەندی'}`);
    }

    if (isRunning24h) {
      const nextDelay = Math.floor(Math.random() * (210000 - 90000)) + 90000;
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
    ctx.reply(`🛑 بۆت ڕاگیرا.\nکۆی جووڵەکان: ${tradeCount}`);
  } else {
    ctx.reply('بۆت ناچالاکە.');
  }
});

bot.launch();
console.log('50/50 Balance Bot operational.');
