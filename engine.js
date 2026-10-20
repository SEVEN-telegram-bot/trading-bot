import { VersionedTransaction } from '@solana/web3.js';
import fetch from 'cross-fetch';

const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function getBalances(connection, walletAddress, tokenMint) {
    const solBalanceLamports = await connection.getBalance(walletAddress);
    const solBalance = solBalanceLamports / 1e9;

    let tokenBalance = 0;
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletAddress, {
            mint: tokenMint
        });
        if (tokenAccounts.value.length > 0) {
            tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
    } catch (e) {
        tokenBalance = 0;
    }

    return {
        sol: solBalance,
        solValueUSD: solBalance * 150,
        tokens: tokenBalance,
        tokenValueUSD: 25
    };
}

export async function executeTrade({ connection, keypair, tokenMint, action, amountUSD }) {
    try {
        const inputMint = action === 'BUY' ? SOL_MINT : tokenMint.toBase58();
        const outputMint = action === 'BUY' ? tokenMint.toBase58() : SOL_MINT;
        
        const amountLamports = Math.floor((amountUSD / 150) * 1e9); 
        if (amountLamports <= 0) return;

        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=100`;
        const quoteResponse = await (await fetch(quoteUrl)).json();

        if (!quoteResponse || quoteResponse.error) {
            throw new Error(quoteResponse?.error || "کێشە لە وەرگرتنی نرخ");
        }

        const swapRes = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: keypair.publicKey.toBase58(),
                    wrapAndUnwrapSol: true,
                })
            })
        ).json();

        const swapTransactionBuf = Buffer.from(swapRes.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([keypair]);

        const txid = await connection.sendTransaction(transaction, {
            skipPreflight: true,
            maxRetries: 2
        });

        console.log(`مامەڵە ئەنجامدرا (${action}): https://solscan.io/tx/${txid}`);
        return txid;
    } catch (err) {
        throw new Error(`شکستی مامەڵە: ${err.message}`);
    }
}
