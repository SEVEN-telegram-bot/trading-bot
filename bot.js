require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');

// وەرگرتنا زانیاریان ژ ژینگەهێ
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');

// ئامادەکرنا والێتێ ژ Private Key
const secretKey = bs58.decode(process.env.PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);

const SOL_MINT = 'So11111111111111111111111111111111111111112';

bot.start((ctx) => {
  ctx.reply(`سلاڤ! بۆتێ تە یێ ترەیدێ ئامادەیە.\n\nوالێتێ بۆتی:\n\`${wallet.publicKey.toBase58()}\``, { parse_mode: 'Markdown' });
});

// فەرمانا زانینا بالانسی /balance
bot.command('balance', async (ctx) => {
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    ctx.reply(`بالانسێ SOL د ناڤ جزدانێ دا: ${(bal / 1e9).toFixed(4)} SOL`);
  } catch (err) {
    ctx.reply(`خەلەتی د بالانسی دا: ${err.message}`);
  }
});

// فونکشنا کڕین و فڕۆتنێ ب رێکا Jupiter
async function executeSwap(inputMint, outputMint, amountInSmallestUnit) {
  // 1. وەرگرتنا نرخ و کوۆت ژ جوپیتەر
  const quoteRes = await axios.get(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInSmallestUnit}&slippageBps=100`
  );
  const quoteResponse = quoteRes.data;

  // 2. دروستکرنا مامەلەیێ
  const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
    quoteResponse,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
  });

  const { swapTransaction } = swapRes.data;

  // 3. ئیمزاکرنا مامەلەیێ ب والێتێ تە
  const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([wallet]);

  // 4. هنارتن بۆ سەر بلۆکچەینێ
  const txid = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });

  return txid;
}

// فەرمانا کڕینێ: /buy [token_address] [sol_amount]
// نموونە: /buy Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53 0.1
bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const tokenAddress = args[1];
  const solAmount = parseFloat(args[2]);

  if (!tokenAddress || isNaN(solAmount)) {
    return ctx.reply('تکایە ب ڤی شێوەی بنڤیسە:\n/buy [token_address] [sol_amount]\nنموونە:\n/buy Ho3DN... 0.1');
  }

  ctx.reply('مامەلە دهێتە ئەنجامدان، تکایە چاڤەڕێبە...');

  try {
    const lamports = Math.floor(solAmount * 1e9);
    const txid = await executeSwap(SOL_MINT, tokenAddress, lamports);
    ctx.reply(`✅ کڕین ب سەرکەفتیانە هاتە کرن!\n\nلینکێ مامەلێ:\nhttps://solscan.io/tx/${txid}`);
  } catch (e) {
    ctx.reply(`❌ خەلەتی ل کڕینێ رویدا: ${e.response?.data?.error || e.message}`);
  }
});

// فەرمانا فڕۆتنێ: /sell [token_address] [amount] [decimals]
// نموونە: /sell Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53 100 9
bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const tokenAddress = args[1];
  const tokenAmount = parseFloat(args[2]);
  const decimals = parseInt(args[3]) || 9;

  if (!tokenAddress || isNaN(tokenAmount)) {
    return ctx.reply('تکایە ب ڤی شێوەی بنڤیسە:\n/sell [token_address] [amount] [decimals]');
  }

  ctx.reply('فڕۆتن دهێتە ئەنجامدان...');

  try {
    const rawAmount = Math.floor(tokenAmount * Math.pow(10, decimals));
    const txid = await executeSwap(tokenAddress, SOL_MINT, rawAmount);
    ctx.reply(`✅ فڕۆتن ب سەرکەفتیانە هاتە کرن!\n\nلینکێ مامەلێ:\nhttps://solscan.io/tx/${txid}`);
  } catch (e) {
    ctx.reply(`❌ خەلەتی ل فڕۆتنێ رویدا: ${e.response?.data?.error || e.message}`);
  }
});

bot.launch();
console.log('Bot is running...');
