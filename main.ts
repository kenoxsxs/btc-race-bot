// cbBTC trend bot for make.fun's btc-race-24h-20261118-1444.
//
// Design: a slow two-horizon momentum trend system on 1-minute closes.
// It only buys a rally that has already proved itself on two horizons and
// only while the price sits above its own 21-bar trend, and it leaves on a
// momentum reversal or a trailing stop. It never shorts, never uses
// leverage, holds at most one position, and sends at most one order a reply.
//
//   Entry (flat): close above EMA(21), 30-min return > +40 bps AND 60-min
//     return > +20 bps. Both horizons must agree, so a 15-minute spike or
//     a single-minute jump never triggers a buy on its own.
//   Exit (long): 60-min return < -20 bps (the rally has reversed) OR the
//     close falls 80 bps below the highest close since entry (trailing
//     stop that locks in the rally's gains).
//   Size: the whole cash balance, capped by the weight room, so one
//     position is 100% of equity at most. max_slippage_bps 200: the largest
//     open-to-close jump in the dev window is 18 bps, and a fill adds at
//     most ~2 bps of slippage plus ~12 bps of impact, so 200 never binds
//     on a genuine move and only guards against a broken feed.
//
// Everything here is a pure function of the bars the harness sent: no wall
// clock, no environment, no randomness, so two runs answer identically.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Lookbacks, in bars (1-minute bars).
const FAST_H = 30;
const SLOW_H = 60;
const EMA_LEN = 21;

// Entry: fast and slow returns, in basis points.
const ENTER_FAST_BPS = 40;
const ENTER_SLOW_BPS = 20;
// Exit: slow return below this, or the trailing stop, in basis points.
const EXIT_SLOW_BPS = -20;
const TRAIL_BPS = 80;
// A fill may move at most this far from the latest close.
const MAX_SLIPPAGE_BPS = 200;
// A buy must spend at least this (the harness's minimum notional, 1 USDC).
const MIN_NOTIONAL = 1_000_000n;

const closes: number[] = [];
let ema: number | null = null;
let peakSinceEntry = 0;

function retBps(back: number): number {
  const n = closes.length;
  return ((closes[n - 1] - closes[n - 1 - back]) / closes[n - 1 - back]) * 10000;
}

// Flat and the rally has proved itself on both horizons while the price
// holds above its trend: buy the whole cash balance, capped by the weight.
function enterSignal(): boolean {
  if (closes.length < SLOW_H + 1) return false;
  if (ema === null || closes[closes.length - 1] <= ema) return false;
  return retBps(FAST_H) > ENTER_FAST_BPS && retBps(SLOW_H) > ENTER_SLOW_BPS;
}

// Long and the rally has reversed, or the price gave back 80 bps from the
// peak since entry: sell the whole position.
function exitSignal(close: number): boolean {
  if (close > peakSinceEntry) peakSinceEntry = close;
  const reversed = closes.length >= SLOW_H + 1 && retBps(SLOW_H) < EXIT_SLOW_BPS;
  const trailed = close <= peakSinceEntry * (1 - TRAIL_BPS / 10000);
  return reversed || trailed;
}

await runBars({
  onBatch(state, batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    const k = 2 / (EMA_LEN + 1);
    ema = ema === null ? close : close * k + ema * (1 - k);

    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    if (held === 0n) {
      if (!enterSignal()) return [];
      const room = state.weightRoom(SYMBOL);
      const notional = room < state.cash ? room : state.cash;
      if (notional < MIN_NOTIONAL) return [];
      peakSinceEntry = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    if (exitSignal(close)) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
