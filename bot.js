const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

if (!BOT_TOKEN || !PRIVATE_KEY) {
  console.error("خەلەتی: پێداویستییەکان دیار نین!");
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
    console.error("خەلەتی د کلیلێ دا:", err);
    process.exit(1);
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
let dcaInterval = null; // پاراستنا فەرمانا کارکردنا بەردەوام

bot.start((ctx) => {
  ctx.reply(`سلاڤ! بۆتێ تە ئامادەیە.\n\nوالێت:\n\`${wallet.publicKey.toBase58()}\`\n\nفەرمانەکان:\n• /balance\n• /buy <CA> <Amount_SOL>\n• /sell <CA> <Amount_Tokens>\n• /dca_sell <CA> <Amount_Tokens> <Minutes>\n• /stop - ڕاگرتنا فرۆتنا بەردەوام`, { parse_mode: 'Markdown' });
});

bot.command('balance', async (ctx) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    ctx.reply(`باڵانسێ SOL: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (error) {
    ctx.reply(`❌ کێشە ل خواندنا باڵانسی: ${error.message}`);
  }
});

// فەنکشنا فرۆتنێ
async function executeSell(mintStr, amount) {
  const mintPubkey = new PublicKey(mintStr);
  const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
  const decimals = mintInfo.value.data.parsed.info.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  const quoteRes = await axios.get('https://public.jupiterapi.com/quote', {
    params: {
      inputMint: mintStr,
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

  return txid;
}

// فرۆتنا تەنێ یەکجار
bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('⚠️ فۆرمات: `/sell <CA> <Tokens>`');
  try {
    await ctx.reply('⏳ فرۆتن دهێتە ئەنجامدان...');
    const txid = await executeSell(args[1], parseFloat(args[2]));
    ctx.reply(`✅ فرۆتن هاتە ئەنجامدان!\nhttps://solscan.io/tx/${txid}`);
  } catch (err) {
    ctx.reply(`❌ کێشە: ${err.message}`);
  }
});

// فرۆتنا بەردەوام (DCA Sell)
bot.command('dca_sell', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 4) {
    return ctx.reply('⚠️ فۆرمات:\n`/dca_sell <CA> <Amount_Each_Time> <Minutes>`\nنموونە بۆ فرۆتنا ٥ تۆکەن هەر ٢ خولەک جاک:\n`/dca_sell Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53 5 2`', { parse_mode: 'Markdown' });
  }

  const ca = args[1];
  const amount = parseFloat(args[2]);
  const minutes = parseFloat(args[3]);

  if (dcaInterval) clearInterval(dcaInterval);

  ctx.reply(`🚀 سیستەمێ DCA دەستپێکرد!\nهەر ${minutes} خۆلەکان جارەکێ بڕێ ${amount} تۆکەن دێ هێنە فرۆتن.\nبۆ ڕاگرتنێ فەرمانا /stop بنێرە.`);

  // جێبەجێکرنا ئێکسەر بۆ جارا ئێکێ
  try {
    const txid = await executeSell(ca, amount);
    ctx.reply(`🔄 [DCA] ترانزاکشنا ئێكێ:\nhttps://solscan.io/tx/${txid}`);
  } catch (err) {
    ctx.reply(`⚠️ [DCA] خەلەتی ل خولی یەکێ: ${err.message}`);
  }

  // خولێن بەردەوام
  dcaInterval = setInterval(async () => {
    try {
      const txid = await executeSell(ca, amount);
      ctx.reply(`🔄 [DCA] فرۆتن هاتە ئەنجامدان:\nhttps://solscan.io/tx/${txid}`);
    } catch (err) {
      ctx.reply(`⚠️ [DCA] خەلەتی لە ئەنجامدان: ${err.message}`);
    }
  }, minutes * 60 * 1000);
});

// ڕاگرتنا پرۆسەیا بەردەوام
bot.command('stop', (ctx) => {
  if (dcaInterval) {
    clearInterval(dcaInterval);
    dcaInterval = null;
    ctx.reply('🛑 فرۆتنا بەردەوام هاتە ڕاگرتن.');
  } else {
    ctx.reply('هیچ پڕۆسەیەکی چالاک نینە بۆ ڕاگرتن.');
  }
});

bot.launch();
console.log('Bot is running with DCA...');
