'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fresh, equity, signal, step } = require('./engine');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = process.env.TELEGRAM_OWNER_ID;
const API_KEY = process.env.JUPITER_API_KEY;
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBLIC_KEYS = (process.env.WALLET_PUBLIC_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA = path.resolve(process.env.DATA_DIR || './data');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const validKey = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
if (!TOKEN || !/^\d+$/.test(OWNER || '') || !API_KEY) {
  console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID and JUPITER_API_KEY. See README.md.'); process.exit(1);
}
if (PUBLIC_KEYS.length && (PUBLIC_KEYS.length !== 4 || new Set(PUBLIC_KEYS).size !== 4 || PUBLIC_KEYS.some(k => !validKey(k)))) {
  console.error('WALLET_PUBLIC_KEYS must be empty or contain four distinct public addresses.'); process.exit(1);
}
if (process.env.PRIVATE_KEY || process.env.PRIVATE_KEYS) {
  console.error('Remove PRIVATE_KEY/PRIVATE_KEYS. This paper-only bot never needs wallet secrets.'); process.exit(1);
}
fs.mkdirSync(DATA, { recursive: true });
const LOCK = path.join(DATA, 'bot.lock');
try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx', mode: 0o600 }); }
catch { console.error('Data directory locked. See README before removing bot.lock.'); process.exit(1); }
const STATE_FILE = path.join(DATA, 'state.json');
let state;
try {
  state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : fresh();
  if (state.version !== 2 || !Array.isArray(state.accounts) || state.accounts.length !== 4 || !Array.isArray(state.events)) throw Error();
  for (const a of state.accounts) {
    if (!Number.isFinite(a.cash) || a.cash < 0 || !Number.isFinite(a.dayStart) ||
        !Number.isFinite(a.lastBuy) || !Number.isFinite(a.buys) || !Number.isFinite(a.spent) ||
        typeof a.halted !== 'boolean' || typeof a.day !== 'string' ||
        (a.position && (!validKey(a.position.mint) || !Number.isFinite(a.position.units) || a.position.units <= 0 ||
          !Number.isFinite(a.position.entry) || a.position.entry <= 0 || !Number.isFinite(a.position.cost)))) throw Error();
  }
} catch { fs.unlinkSync(LOCK); console.error('Invalid saved state; restore a backup. State was not reset.'); process.exit(1); }
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, STATE_FILE);
}
save();
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.json();
}
async function telegram(method, body) {
  const r = await json(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw Error('Telegram request failed'); return r.result;
}
async function tell(text) {
  try { await telegram('sendMessage', { chat_id: OWNER, text }); }
  catch { console.error('Notification failed; inspect /status and /history.'); }
}
async function rpc(method, params) {
  const r = await json(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (r.error || r.result === undefined) throw Error('RPC read failed'); return r.result;
}
async function priceFor(mint) {
  const info = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const parsed = info.value?.data?.parsed;
  const decimals = parsed?.info?.decimals;
  if (parsed?.type !== 'mint' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw Error('Invalid token mint');
  const params = new URLSearchParams({ inputMint: USDC, outputMint: mint, amount: '5000000', slippageBps: '50', swapMode: 'ExactIn' });
  const q = await json(`https://api.jup.ag/swap/v1/quote?${params}`, { headers: { 'x-api-key': API_KEY } });
  if (q.inputMint !== USDC || q.outputMint !== mint || q.inAmount !== '5000000' ||
      typeof q.outAmount !== 'string' || !/^\d+$/.test(q.outAmount) || BigInt(q.outAmount) <= 0n ||
      q.priceImpactPct === undefined || !Number.isFinite(Number(q.priceImpactPct)) || Math.abs(Number(q.priceImpactPct)) > 0.01 ||
      !q.routePlan?.length) throw Error('Quote missing, invalid, or price impact exceeds 1%');
  const price = 5 / (Number(q.outAmount) / 10 ** decimals);
  if (!Number.isFinite(price) || price <= 0) throw Error('Invalid price');
  return price;
}
let session = null, generation = 0, timer = null, busy = false, closing = false;
function stop() { generation++; session = null; clearTimeout(timer); timer = null; }
async function tick(id) {
  if (!session || generation !== id || closing) return;
  if (busy) { timer = setTimeout(() => tick(id), 1000); return; }
  busy = true;
  try {
    const current = session;
    const price = await priceFor(current.mint);
    if (generation !== id || closing) return;
    current.errors = 0; current.price = price; current.asOf = Date.now();
    current.prices.push(price); if (current.prices.length > 21) current.prices.shift();
    const side = signal(current.prices);
    const event = step(state.accounts[current.index], { price, mint: current.mint, side });
    if (event) {
      state.events.push({ ...event, account: current.index + 1, mode: 'PAPER' });
      if (state.events.length > 2000) state.events.shift();
    }
    save();
    if (event) await tell(`PAPER ${event.side} | Account ${current.index + 1}\n${event.reason}\nPrice: ${price.toPrecision(7)} USDC\nCash: ${state.accounts[current.index].cash.toFixed(2)} USDC\nSimulated only. No transaction sent.`);
  } catch (e) {
    if (generation !== id) return;
    if (session) session.prices = [];
    if (e.code) { stop(); await tell('Stopped: local data could not be saved. Check disk and restart.'); }
    else if (session && ++session.errors >= 3) { stop(); await tell('Stopped after 3 market-data errors. Check RPC/API configuration and restart explicitly.'); }
    else await tell('Market data unavailable or rejected. This sample was skipped.');
  } finally {
    busy = false;
    if (session && generation === id && !closing) timer = setTimeout(() => tick(id), 60000);
  }
}
const help = `PAPER trading only — no real orders. Four separate simulated accounts, 100 USDC each.\n/start_smart TOKEN_MINT ACCOUNT_NUMBER — monitor one account (1–4)\n/stop — stop monitoring\n/status — simulated balances and position\n/history — last 10 simulated trades\n/balance — real SOL balances, read-only\n21 one-minute samples are required for a crossover signal. Restart does not auto-resume.\nLimits per account: order 5, reserve 20, daily entry budget 20, daily loss circuit 5 USDC. These are unvalidated demo settings, not profit promises.`;
async function command(message) {
  // Authorize the sender AND the private chat before parsing any command.
  if (String(message.from?.id) !== OWNER || String(message.chat?.id) !== OWNER || message.chat?.type !== 'private') return;
  const [raw, ...args] = (message.text || '').trim().split(/\s+/);
  const name = raw.split('@')[0];
  if (name === '/start' || name === '/help') return tell(help);
  if (name === '/stop') { stop(); return tell('Monitoring stopped. Paper positions remain recorded; no automatic exits occur while stopped.'); }
  if (name === '/start_smart') {
    if (session) return tell('Already running. Use /stop before changing account or token.');
    const [mint, number] = args, index = Number(number) - 1;
    if (args.length !== 2 || !validKey(mint) || mint === USDC || !Number.isInteger(index) || index < 0 || index > 3) return tell('Usage: /start_smart TOKEN_MINT ACCOUNT_NUMBER (1–4)');
    if (state.accounts[index].position && state.accounts[index].position.mint !== mint) return tell('Resume the token of this account’s existing paper position first.');
    session = { mint, index, prices: [], errors: 0, price: null, asOf: null };
    const id = ++generation;
    await tell(`PAPER monitoring started for account ${index + 1}. Signals need 21 samples. No real funds are used.`);
    void tick(id); return;
  }
  if (name === '/status') {
    const lines = state.accounts.map((a, i) => {
      const active = session?.index === i && session.price;
      return `${i + 1}: cash ${a.cash.toFixed(2)} USDC; ${a.position ? `position ${a.position.units.toPrecision(6)} units of ${a.position.mint}` : 'no position'}${active ? `; indicative equity ${equity(a, session.price).toFixed(2)}` : ''}; halted ${a.halted}`;
    });
    return tell(`PAPER ONLY\n${lines.join('\n')}\n${session ? `Running account ${session.index + 1}; samples ${session.prices.length}/21; last quote ${session.asOf ? new Date(session.asOf).toISOString() : 'pending'}` : 'Stopped'}`);
  }
  if (name === '/history') return tell(state.events.slice(-10).map(e => `${new Date(e.now).toISOString()} PAPER #${e.account} ${e.side} ${e.reason}${e.pnl === undefined ? '' : ` P/L ${e.pnl.toFixed(2)} USDC`}`).join('\n') || 'No simulated trades yet.');
  if (name === '/balance') {
    if (!PUBLIC_KEYS.length) return tell('Set WALLET_PUBLIC_KEYS to the four public addresses. Never add private keys.');
    const lines = [];
    for (let i = 0; i < PUBLIC_KEYS.length; i++) {
      const b = await rpc('getBalance', [PUBLIC_KEYS[i], { commitment: 'confirmed' }]);
      if (!Number.isSafeInteger(b.value) || b.value < 0) throw Error('Invalid balance');
      lines.push(`${i + 1}: ${(b.value / 1e9).toFixed(6)} SOL`);
    }
    return tell(`Real native SOL only (read-only; SPL tokens not included):\n${lines.join('\n')}\nPaper balances are separate. No assumption about real $100 holdings is made.`);
  }
}
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Paper bot online'); });
server.listen(Number(process.env.PORT || 10000));
async function shutdown() {
  if (closing) return; closing = true; stop(); server.close();
  fs.unlinkSync(LOCK); process.exit(0);
}
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
async function main() {
  // Drop queued commands on each restart, so stale start commands are not replayed.
  await telegram('deleteWebhook', { drop_pending_updates: true });
  await tell('PAPER bot online and stopped. /help for commands. No real trading is implemented.');
  let offset = 0;
  while (!closing) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 10, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          try { await command(update.message); }
          catch { await tell('Command failed. Check configuration or connectivity. No transaction was sent.'); }
        }
      }
    } catch { console.error('Telegram polling unavailable; retrying.'); await new Promise(r => setTimeout(r, 5000)); }
  }
}
main().catch(() => { console.error('Startup failed. Check Telegram configuration.'); shutdown(); });
