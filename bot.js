const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const bs58 = require('bs58');

// 1. ڕێکخستنێن سەرەکی
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com"; // یان ئەدرێسێ QuickNode / Helius
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// کلیلێ تایبەت (Private Key) یێ والێتا بۆتێ لێرە دابنێ (ب شێوازێ Base58)
const PRIVATE_KEY_BS58 = "PASTE_YOUR_BOT_WALLET_PRIVATE_KEY_HERE";
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BS58));

// ناڤونیشانێ فەرمی یێ کوینێ SEVEN و WSOL
const SEVEN_MINT = "Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// 2. فەنکشنا لێکگۆڕینێ ب ڕێکا Jupiter API
async function executeSwap(inputMint, outputMint, amountRaw) {
    try {
        // وەرگرتنا نرخ و ڕێڕەوێ ترەیدێ (Quote)
        const quoteResponse = await (
            await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=150`)
        ).json();

        if (!quoteResponse || quoteResponse.error) {
            console.error("خەلەتی د وەرگرتنا نرخیدا:", quoteResponse?.error || "No route found");
            return;
        }

        // وەرگرتنا ترانزاکشنێ ژ سێرڤەری
        const { swapTransaction } = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    prioritizationFeeLamports: 100000 // Priority Fee دا ترانزاکشن ب لەز بچیت
                })
            })
        ).json();

        // ئیمزاکرنا ترانزاکشنێ و فرێکرن
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 3
        });

        console.log(` ترانزاکشن هاتە فرێکرن! سحکە Solscan: https://solscan.io/tx/${txid}`);
    } catch (err) {
        console.error("خەلەتیا ترانزاکشنێ:", err.message);
    }
}

// 3. ستراتیژیا زیندی ڕاگرتنا چارتێ (فرۆتن زێدەتر بیت ژ کڕینێ)
async function startMarketMaker() {
    console.log(" بۆت ب سەرکەفتیانە دەستپێکر ژ والێتا:", wallet.publicKey.toString());

    while (true) {
        // دیارکرنا کڕین یان فرۆتن: 60% دەلانسی بو فرۆتنێیە دا سولانا کۆم ببیت
        const isSell = Math.random() < 0.60;

        if (isSell) {
            // فرۆتنەکا بچووک (بۆ نموونە: 15 هەتا 35 کۆینێن SEVEN ب شێوەیەکێ هەڕەمەکی)
            const tokenDecimals = 6; // ئەگەر دسیمالێ SEVEN جودابیت بگۆڕە بۆ 9
            const randomAmount = Math.floor(Math.random() * (35 - 15 + 1) + 15);
            const rawSellAmount = randomAmount * Math.pow(10, tokenDecimals);

            console.log(`[SELL] دێ بڕێ ${randomAmount} SEVEN فرۆشیت بۆ سۆلانا...`);
            await executeSwap(SEVEN_MINT, SOL_MINT, rawSellAmount);

        } else {
            // کڕینەکا بچووک (بۆ نموونە: 0.015 هەتا 0.035 SOL دا مۆما کەسک بدانیت)
            const randomSol = (Math.random() * (0.035 - 0.015) + 0.015).toFixed(3);
            const rawBuyAmount = Math.floor(parseFloat(randomSol) * 1e9);

            console.log(`[BUY] دێ بڕێ ${randomSol} SOL کڕیتە SEVEN دا چارت کەسک ببیت...`);
            await executeSwap(SOL_MINT, SEVEN_MINT, rawBuyAmount);
        }

        // وەستان د ناڤبەرا ٦٠ چرکە بۆ ١٨٠ چرکە (١ بۆ ٣ خۆلەکان) ب شێوازێ هەڕەمەکی
        const delaySeconds = Math.floor(Math.random() * (180 - 60 + 1) + 60);
        console.log(` ل هیڤیێ بە بۆ ماوێ ${delaySeconds} چرکان...`);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
}

// دەستپێکرنا بازنێ ترەیدانێ
startMarketMaker();
