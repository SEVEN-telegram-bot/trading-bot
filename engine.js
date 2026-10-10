'use strict';
const LIMITS = Object.freeze({ initial: 100, reserve: 20, order: 5, dailyLoss: 5,
  dailyBuys: 4, dailySpend: 20, cooldownMs: 3600000, stop: 0.05, profit: 0.10,
  friction: 0.005, fee: 0.05 });
function fresh() {
  return { version: 2, accounts: Array.from({ length: 4 }, () => ({ cash: 100,
    position: null, lastBuy: 0, day: '', dayStart: 100, buys: 0, spent: 0, halted: false })), events: [] };
}
function equity(a, price) { return a.cash + (a.position ? a.position.units * price : 0); }
function signal(prices) {
  if (prices.length < 21) return 'WAIT';
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const previous = prices.slice(0, -1), current = prices;
  const oldDiff = mean(previous.slice(-5)) - mean(previous.slice(-20));
  const diff = mean(current.slice(-5)) - mean(current.slice(-20));
  if (oldDiff <= 0 && diff > 0) return 'BUY';
  if (oldDiff >= 0 && diff < 0) return 'SELL';
  return 'HOLD';
}
function step(a, { price, mint, side, now = Date.now() }) {
  if (!(Number.isFinite(price) && price > 0)) throw Error('Invalid market price');
  if (a.position && a.position.mint !== mint) throw Error('Open position belongs to another token');
  const day = new Date(now).toISOString().slice(0, 10);
  if (a.day !== day) {
    a.day = day; a.dayStart = equity(a, price); a.buys = 0; a.spent = 0;
    a.halted = false;
  }
  const loss = a.dayStart - equity(a, price);
  if (loss >= LIMITS.dailyLoss) a.halted = true;
  const p = a.position;
  let reason = null;
  if (p) {
    if (a.halted) reason = 'daily-loss circuit';
    else if (price <= p.entry * (1 - LIMITS.stop)) reason = 'stop threshold';
    else if (price >= p.entry * (1 + LIMITS.profit)) reason = 'profit threshold';
    else if (side === 'SELL') reason = 'moving-average crossover';
    if (reason) {
      const proceeds = Math.max(0, p.units * price * (1 - LIMITS.friction) - LIMITS.fee);
      a.cash += proceeds; a.position = null;
      return { side: 'SELL', reason, price, units: p.units, proceeds, pnl: proceeds - p.cost, now, mint };
    }
    return null;
  }
  if (side !== 'BUY' || a.halted || a.buys >= LIMITS.dailyBuys ||
    a.spent + LIMITS.order > LIMITS.dailySpend ||
    (a.lastBuy && now - a.lastBuy < LIMITS.cooldownMs) ||
    a.cash - LIMITS.order - LIMITS.fee < LIMITS.reserve) return null;
  const units = LIMITS.order / (price * (1 + LIMITS.friction));
  const cost = LIMITS.order + LIMITS.fee;
  a.position = { mint, units, entry: price, cost };
  a.cash -= cost; a.lastBuy = now; a.buys++; a.spent += LIMITS.order;
  return { side: 'BUY', reason: 'moving-average crossover', price, units, cost, now, mint };
}
module.exports = { LIMITS, fresh, equity, signal, step };
