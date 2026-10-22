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

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Organic Market Flow Active.');
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
  let msg = `⚙️ **بۆتی دروستکردنی چارتی سروشتی و سەوز**\n\nوالێتەکان: *${wallets.length}*\n• سیستەم: ٧٠٪ کڕینی بەردەوام و ورد بۆ سەوز هێشتنەوەی چارت بەبێ دروستکردنی گومان.\n• باڵانس: پاراستنی هاوسەنگی نیوە بە نیوە بەبێ خاڵیبوونەوە.\n\n`;
  wallets.forEach((w, i) => {
    msg += `${i + 1}. \`${w.publicKey.toBase58()}\`\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    const ca = 'Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53';
    let msg = `📊 **باڵانسی ئێستای والێتەکان:**\n\n`;
    for (let i = 0; i < wallets.length; i++) {
      const bSol = await safeGetBalance(wallets[i].publicKey);
      const bToken = await safeGetTokenBalance(wallets[i].publicKey, ca);
      msg += `والێت ${i + 1}:\n• SOL: ${(bSol / LAMPORTS_PER_SOL).toFixed(4)}\n• SEVEN: ${bToken.uiAmount.toFixed(2)}\n\n`;
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`هەڵە لە باڵانس: ${error.message}`);
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

  ctx.reply(`🚀 **سیستەمی چارتی سروشتی (زۆرینەی سەوز) دەستی پێکرد!**\n\n• تایبەتمەندی: زۆربەی ئۆردەرەکان کڕینن تا چارت بە سەوزی بمێنێتەوە.\n• فرۆشتن تەنها لە کاتی پێویست و بە ڕێژەیەکی کەم بۆ پاراستنی باڵانسی SOL ئەنجام دەدرێت.\n• ماوەی نێوان ئۆردەرەکان: ١ بۆ ٣ خولەک بە شێوەی هەڕەمەکی.\n• ڕاگرتن: /stop`);

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

      // بەستنی بڕیار لەسەر ٧٠٪ کڕین و تەنها ٣٠٪ فرۆشتن لە کاتی پێویست
      let action = 'BUY';
      
      // تەنها کاتێک دەفڕۆشێت ئەگەر SOL کەمی کردبێت (خوار 0.04 SOL) یان بە ئەگەری کەم (٢٥٪) بۆ ئەوەی چارتەکە فەیک دەرنەکەوێت
      if ((solBal < 0.04 * LAMPORTS_PER_SOL && tokenBal.uiAmount > 5) || (Math.random() < 0.25 && tokenBal.uiAmount > 10)) {
        action = 'SELL';
      }

      if (action === 'BUY' && solBal > 0.015 * LAMPORTS_PER_SOL) {
        // بڕی کڕینی ورد و هەڕەمەکی بۆ ئەوەی وەکو کڕیاری ڕاستەقینە دەربکەوێت
        const buySol = parseFloat((Math.random() * (0.018 - 0.007) + 0.007).toFixed(5));
        const txid = await executeBuy(activeWallet, ca, buySol);
        ctx.reply(`🟢 [خولی #${currentLoop} | والێت ${activeWalletIdx + 1} (${shortAddr})]\nکڕینی سەوزکردنی چارت ئەنجامدرا (~${buySol} SOL):\nhttps://solscan.io/tx/${txid}`);
      } else if (tokenBal.uiAmount > 2) {
        // فرۆشتنی تەنها بڕێکی زۆر بچووک (٥٪ بۆ ١٢٪) لە تۆکنەکان تا باڵانسی چارت تێکنەچێت
        const sellFraction = (Math.random() * (0.12 - 0.05) + 0.05);
        const sellRaw = Math.floor(Number(tokenBal.rawAmount) * sellFraction).toString();
        const res = await executeSell(activeWallet, ca, sellRaw);
        ctx.reply(`🔴 [خولی #${currentLoop} | والێت ${activeWalletIdx + 1} (${shortAddr})]\nفرۆشتنی باڵانس ئەنجامدرا (+${res.solGained} SOL گەڕایەوە):\nhttps://solscan.io/tx/${res.txid}`);
      }

    } catch (err) {
      console.error(err);
      ctx.reply(`⚠️ ئاگاداری لە خولی #${currentLoop}: ${err.message || 'هەڵە لە تۆڕ'}`);
    }

    if (isRunning24h) {
      // کاتی هەڕەمەکی لە نێوان ٧٥ بۆ ١٩٠ چرکە بۆ سروشتی دەرکەوتنی ترانزاکشنەکان
      const nextDelay = Math.floor(Math.random() * (190000 - 75000)) + 75000;
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
console.log('Organic Bullish Chart Engine operational.');
