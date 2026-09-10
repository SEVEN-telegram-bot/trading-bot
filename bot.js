const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

// خوندنا زانیاریان ژ Environment Variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEY) {
  console.error("خەلەتی: TELEGRAM_BOT_TOKEN یان PRIVATE_KEY نەهاتیە دیارکرن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

// دروستکرنا Keypair ژ کلیلێ نهێنی
let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
} catch (e) {
  try {
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)));
  } catch (err) {
    console.error("خەلەتی د کلیلێ نهێنی دا هەیە:", err);
    process.exit(1);
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// فەرمانا دەستپێکێ
bot.start((ctx) => {
  ctx.reply(`سلاڤ! بۆتێ تە یێ ترەیدێ ئامادەیە.\n\nوالێتێ بۆتی:\n\`${wallet.publicKey.toBase58()}\`\n\nفەرمانێن بەردەست:\n• /balance - پشکنینا باڵانسێ جزدانێ\n• /buy <CA> <Amount_SOL> - کڕینا تۆکەنی\n• /sell <CA> <Token_Amount> - فرۆتنا تۆکەنی`, { parse_mode: 'Markdown' });
});

// فەرمانا پشکنینا باڵانسی
bot.command('balance', async (ctx) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    ctx.reply(`باڵانسێ SOL د ناڤ جزدانێ دا: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (error) {
    ctx.reply(`❌ خەلەتی ل خواندنا باڵانسی: ${error.message}`);
  }
});

// فەرمانا کڕینێ (Buy)
bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.reply('⚠️ فۆرمات خەلەتە!\nنموونە:\n`/buy Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53 0.01`', { parse_mode: 'Markdown' });
  }

  const outputMint = args[1];
  const solAmount = parseFloat(args[2]);

  if (isNaN(solAmount) || solAmount <= 0) {
    return ctx.reply('⚠️ بڕێ SOL نەدروستە!');
  }

  const statusMsg = await ctx.reply('⏳ مامەلە دهێتە ئەنجامدان، تکایە چاڤەڕێبە...');

  try {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    // ۱. وەرگرتنا نرخ و ڕێڕەو ژ Jupiter API V6 یێ فەرمی
    const quoteRes = await axios.get(`https://quote-api.jup.ag/v6/quote`, {
      params: {
        inputMint: SOL_MINT,
        outputMint: outputMint,
        amount: lamports,
        slippageBps: 50 // 0.5% Slippage
      },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000
    });

    const quoteResponse = quoteRes.data;

    // ۲. وەرگرتنا ترانزاکشنێ بۆ ئیمزاکرنێ
    const swapRes = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000
    });

    const { swapTransaction } = swapRes.data;

    // ۳. دەسکاری و ئیمزاکرنا ترانزاکشنێ
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    // ٤. ناردنا ترانزاکشنێ بۆ سەر تۆڕا سۆلانا
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3
    });

    // ٥. پشتڕاستکرن
    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid
    }, 'confirmed');

    ctx.reply(`✅ کڕین ب سەرکەفتی ئەنجامدرا!\n\n🔗 تەماشاکردنی ترانزاکشن:\nhttps://solscan.io/tx/${txid}`);
  } catch (error) {
    console.error(error);
    const errText = error.response ? JSON.stringify(error.response.data) : error.message;
    ctx.reply(`❌ خەلەتی ل کڕینێ ڕوویدا:\n${errText}`);
  }
});

// فەرمانا فرۆتنێ (Sell)
bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.reply('⚠️ فۆرمات خەلەتە!\nنموونە:\n`/sell Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53 100`', { parse_mode: 'Markdown' });
  }

  const inputMint = args[1];
  const tokenAmount = parseFloat(args[2]);

  if (isNaN(tokenAmount) || tokenAmount <= 0) {
    return ctx.reply('⚠️ بڕێ تۆکەنان نەدروستە!');
  }

  await ctx.reply('⏳ مامەلەیا فرۆتنێ دهێتە ئەنجامدان، تکایە چاڤەڕێبە...');

  try {
    // دۆزینەوەیا Decimals یێ تۆکەنی
    const mintPubkey = new PublicKey(inputMint);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const decimals = mintInfo.value.data.parsed.info.decimals;
    const rawAmount = Math.floor(tokenAmount * Math.pow(10, decimals));

    // ۱. وەرگرتنا Quote ژ Jupiter
    const quoteRes = await axios.get(`https://quote-api.jup.ag/v6/quote`, {
      params: {
        inputMint: inputMint,
        outputMint: SOL_MINT,
        amount: rawAmount,
        slippageBps: 100 // 1% Slippage بۆ فرۆتنێ
      },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000
    });

    const quoteResponse = quoteRes.data;

    // ۲. سازکرنا ترانزاکشنا Swap
    const swapRes = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000
    });

    const { swapTransaction } = swapRes.data;

    // ۳. ئیمزاکرن و ناردن
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3
    });

    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid
    }, 'confirmed');

    ctx.reply(`✅ فرۆتن ب سەرکەفتی ئەنجامدرا!\n\n🔗 تەماشاکردنی ترانزاکشن:\nhttps://solscan.io/tx/${txid}`);
  } catch (error) {
    console.error(error);
    const errText = error.response ? JSON.stringify(error.response.data) : error.message;
    ctx.reply(`❌ خەلەتی ل فرۆتنێ ڕوویدا:\n${errText}`);
  }
});

// دەستپێکرنا بۆتی
bot.launch();
console.log('Solana Trading Bot سەرکەوتووانە دەستی بەکار کرد!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
