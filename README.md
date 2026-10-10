# Solana Telegram Paper Bot — v2

**PAPER ONLY. No real purchases, sales, transaction signing or broadcasting.**
The earlier random chart-activity loop has been removed. This version tests an
illustrative moving-average strategy using market quotes. It does not disguise
automation, generate on-chain volume, or promise returns.

## دەستپێکرن — بەهدینی

- ئەڤ وەشانە تەنێ تاقیکرنە؛ هیچ پارەیەک ژ والتێن تە ناخەرج کەت.
- ٤ حسابێن تاقیکرنێ هەنە، هەر ئێک ب ١٠٠ USDC. ئەڤە باڵانسێ ڕاستەقینە نینە.
- `.env.example` کۆپی بکە ب ناڤێ `.env` و خانەیێن پێدڤی پڕ بکە.
- `TELEGRAM_OWNER_ID` ژمارەیا ناسنامەیا تێلیگرامێ یا تەیە، نە ناڤێ بەکارهێنەری.
- کلیلا نهێنی یان seed phrase مەدە بوتی. `PRIVATE_KEY` ژ ڕێکخستنان ژێببە.
- Node.js 22 یان نووتر پێدڤییە. ب `npm start` بوتی ڤەکە.
- د چاتا تایبەت یا بوتی دا `/help` بنڤیسە.
- بۆ دەستپێکرنێ: `/start_smart TOKEN_MINT 1`؛ `TOKEN_MINT` ب ناڤنیشانێ توکنێ بگوهۆڕە.
- بۆ ڕاگرتنێ `/stop`؛ بۆ ئەنجامان `/status` و `/history`.
- ٢١ نمونەیێن نرخێ، نزیکەی ٢٠ خولەک یان پتر، پێدڤی نە بۆ یەکەم سیگناڵێ.
- تەنێ حسابەک ل جارەکێ دهێتە تاقیکرن؛ ژمارە ١ تا ٤ هەلبژێرە.

## Setup

1. Use Node.js 22+; there are no third-party npm dependencies.
2. Copy `.env.example` to `.env` locally, or set equivalent host environment variables.
3. Set `TELEGRAM_BOT_TOKEN`, numeric `TELEGRAM_OWNER_ID`, and `JUPITER_API_KEY`.
   Create the Jupiter key at https://developers.jup.ag/portal.
4. Optionally set `WALLET_PUBLIC_KEYS` to exactly four distinct public addresses,
   comma separated. These are used ONLY by `/balance`. They do not fund, map to,
   or control the simulated accounts. Never supply private keys.
5. Run `npm test`, then `npm start`. Open a private chat with the bot and send `/help`.

For Render: start command `npm start`, Node 22+, one instance only. Attach a
persistent disk and set `DATA_DIR` to a directory on that disk (for example
`/var/data/paper-bot`). Without persistent storage, a redeploy can lose simulation
history. A health endpoint listens on `PORT` (default 10000); it does not prevent
hosting services from suspending an inactive free instance.

## Commands

| Command | Function |
| --- | --- |
| `/start`, `/help` | Instructions |
| `/start_smart TOKEN_MINT 1` | Start quote sampling for account 1 (choose 1–4) |
| `/stop` | Stop monitoring; keep paper positions recorded |
| `/status` | Paper cash, positions, account status and quote timestamp |
| `/history` | Last ten simulated events |
| `/balance` | Real native SOL balances, read-only; excludes SPL tokens |

All commands require the configured owner in their private chat. Restart drops
pending Telegram updates and never resumes monitoring automatically. `/stop`
invalidates in-flight samples before they can produce a new paper trade. It does
not close existing positions. While stopped, no price checks or exits occur.
Switching away from an account also leaves that account's positions unmonitored.

## Simulation rules (examples, not validated investment settings)

- Four independent initial balances of **100 simulated USDC**. No live funds move.
- Poll once per minute after the preceding request completes; no overlapping work.
- Enter only when a 5-sample moving average crosses above a 20-sample average.
  A rising price alone does not force a trade. Warmup requires 21 valid samples.
- Exit on a downward crossover, 5% stop threshold or 10% profit threshold.
- One position per account. Order size 5 USDC plus a 0.05 USDC simulated fee.
- Cash reserve 20 USDC; at most four buys / 20 USDC entry notional per UTC day.
- One hour minimum between entries. Daily marked equity loss of 5 USDC triggers
  a paper exit and blocks entries for the rest of that UTC day. Counters reset on
  the first valid sample of the next UTC day. Restart preserves these counters.
- Entry and exit model 0.5% adverse friction plus 0.05 USDC fee per side.
- Quotes over 1% reported price impact are rejected. Three consecutive failures
  stop monitoring. Missing samples clear crossover warmup; position risk checks
  resume with the next valid price. No stale prices generate simulated fills.

The 5 USDC loss circuit is a trigger, not a guaranteed maximum loss. Price gaps,
missing quotes and outages can exceed it. Fees are illustrative, not live network
fee estimates. The 20 USDC reserve is simulated cash, NOT an on-chain SOL gas
reserve. Real SOL gas is never spent by this version.

## Market data and limitations

Uses official Jupiter `GET https://api.jup.ag/swap/v1/quote` with `x-api-key`,
and read-only Solana RPC `getAccountInfo` / `getBalance`.
Reference: https://developers.jup.ag/docs/guides/how-to-build-a-custom-swap-with-metis
Metis v1 is a legacy API; availability and API terms may change.

A 5 USDC buy quote gives an **indicative** USDC/token price. Paper exits reuse that
price with modeled friction; they are NOT executable sell quotes. USDC is not
assumed to have a guaranteed USD value. Token transfer fees, sell restrictions,
liquidity gaps, taxes and rent are not fully modeled. Simulation success is no
evidence of profitability or of a token's safety. There is deliberately no LIVE
flag, signer, swap POST, transaction builder or broadcast path.

## Data and troubleshooting

`DATA_DIR/state.json` stores balances, positions, UTC limits, and the most recent
2,000 paper events. It is replaced atomically after each valid sample. Back it up
while the process is stopped. Invalid state fails closed instead of resetting
balances. `bot.lock` prevents two processes sharing a data directory. After an
unclean process/container crash, stop all instances and only then remove a stale
`bot.lock`. Do not run copies against separate data directories with the same
Telegram token. No log contains environment secrets.

Check the owner ID if commands do nothing. For data errors, check the Jupiter
API key, mint address, RPC access and quota. Private keys from the old deployment
must be removed; startup rejects them. Wallet addresses are optional for paper
trading. No private keys were present in the supplied archive.

## Validation

`npm test` covers crossover warmup, account isolation, duplicate entry prevention,
position exits and cost accounting, cash reserve, daily budgets, cooldown,
loss circuit, UTC rollover, invalid prices, mint switching and state persistence.
An isolated integration test also checks owner authorization and cancellation of
an in-flight sample, with all network responses mocked. All 11 tests passed.
No live Telegram, Jupiter, RPC integration or real transaction was tested during
this edit; user credentials and network access are required for market operation.
