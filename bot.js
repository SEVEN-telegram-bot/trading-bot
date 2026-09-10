const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEY) {
  console.error("خەلەتی: زانیاریێن پێدڤی کێمن!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL, 'confirmed');

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
} catch (e) {
  try {
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)));
  } catch (err) {
    console.error("خەلەتی د کلیلێ دا هەیە:", err);
    process.exit(1);
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

bot.start((ctx) => {
  ctx.reply(`سلاڤ! بۆت ئامادەیە.\n\nوالێت:\n\`${wallet.publicKey.toBase58()}\``, { parse_mode: 'Markdown' });
});

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
    return ctx.reply('⚠️ فۆرمات: `/buy <CA> <Amount_SOL>`', { parse_mode: 'Markdown' });
  }

  const outputMint = args[1];
  const solAmount = parseFloat(args[2]);

  if (isNaN(solAmount) || solAmount <= 0) {
    return ctx.reply('⚠️ بڕێ SOL خەلەتە!');
  }

  await ctx.reply('⏳ مامەلە دهێتە ئەنجامدان، چاڤەڕێبە...');

  try {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
      params: {
        inputMint: SOL_MINT,
        outputMint: outputMint,
        amount: lamports,
        slippageBps: 100
      },
      timeout: 10000
    });

    const quoteResponse = quoteRes.data;

    const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const { swapTransaction } = swapRes.data;
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3
    });

    ctx.reply(`✅ کڕین هاتە ئەنجامدان!\n\n🔗 Solscan:\nhttps://solscan.io/tx/${txid}`);
  } catch (error) {
    console.error(error);
    const errData = error.response ? JSON.stringify(error.response.data) : error.message;
    ctx.reply(`❌ خەلەتی ل کڕینێ:\n${errData}`);
  }
});

// فەرمانا فرۆتنێ (Sell)
bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.reply('⚠️ فۆرمات: `/sell <CA> <Amount_Tokens>`', { parse_mode: 'Markdown' });
  }

  const inputMint = args[1];
  const tokenAmount = parseFloat(args[2]);

  if (isNaN(tokenAmount) || tokenAmount <= 0) {
    return ctx.reply('⚠️ بڕێ تۆکەنان خەلەتە!');
  }

  await ctx.reply('⏳ مامەلەیا فرۆتنێ دهێتە ئەنجامدان، چاڤەڕێبە...');

  try {
    const mintPubkey = new PublicKey(inputMint);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const decimals = mintInfo.value.data.parsed.info.decimals;
    const rawAmount = Math.floor(tokenAmount * Math.pow(10, decimals));

    const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
      params: {
        inputMint: inputMint,
        outputMint: SOL_MINT,
        amount: rawAmount,
        slippageBps: 150
      },
      timeout: 10000
    });

    const quoteResponse = quoteRes.data;

    const swapRes = await axios.post('https://public.jupiterapi.com/swap', {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const { swapTransaction } = swapRes.data;
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3
    });

    ctx.reply(`✅ فرۆتن هاتە ئەنجامدان!\n\n🔗 Solscan:\nhttps://solscan.io/tx/${txid}`);
  } catch (error) {
    console.error(error);
    const errData = error.response ? JSON.stringify(error.response.data) : error.message;
    ctx.reply(`❌ خەلەتی ل فرۆتنێ:\n${errData}`);
  }
});

bot.launch();
console.log('Bot is running...');
