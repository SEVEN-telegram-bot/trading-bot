import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { executeTrade, getBalances } from './engine.js';

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const SEVEN_MINT = new PublicKey("Ho3DNyGDTuKoFdA1bd6obE9xaL4RuStHUW1eLpodHS53");

// لێرەدا کلیلە تایبەتەکانی ٤ والێتەکە دابنێ
const WALLET_KEYS = [
    "PRIVATE_KEY_WALLET_1",
    "PRIVATE_KEY_WALLET_2",
    "PRIVATE_KEY_WALLET_3",
    "PRIVATE_KEY_WALLET_4"
];

function getRandomDelay(minSec = 45, maxSec = 180) {
    return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
}

function getRandomAmountUSD(min = 0.8, max = 2.5) {
    return parseFloat((Math.random() * (max - min) + min).toFixed(2));
}

async function runWalletLoop(keypair, index) {
    console.log(`[Wallet ${index + 1}] چالاککرا: ${keypair.publicKey.toBase58()}`);

    while (true) {
        try {
            const balances = await getBalances(connection, keypair.publicKey, SEVEN_MINT);
            
            let action = Math.random() > 0.5 ? 'BUY' : 'SELL';
            
            if (balances.solValueUSD < 5) action = 'SELL';
            if (balances.tokenValueUSD < 5) action = 'BUY';

            const tradeSizeUSD = getRandomAmountUSD(0.8, 2.5);

            console.log(`[Wallet ${index + 1}] ئەنجامدانی: ${action} بە بڕی ~$${tradeSizeUSD}`);
            
            await executeTrade({
                connection,
                keypair,
                tokenMint: SEVEN_MINT,
                action,
                amountUSD: tradeSizeUSD
            });

        } catch (err) {
            console.error(`[Wallet ${index + 1}] کێشە:`, err.message);
        }

        const waitTime = getRandomDelay(30, 150);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
}

async function start() {
    console.log("بۆت دەستی بە کارکردن کرد...");
    WALLET_KEYS.forEach((pk, idx) => {
        try {
            const keypair = Keypair.fromSecretKey(bs58.decode(pk));
            runWalletLoop(keypair, idx);
        } catch (e) {
            console.error(`کلیلی والێتی ${idx + 1} هەڵەیە:`, e.message);
        }
    });
}

start();
