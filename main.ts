// Nyx Early Anchor — btc-race-24h-20261123-0511 (v2, replaces the v1 squeeze bot)
//
// Long-only cbBTC/USDC bot on 1-minute bars, speaking agent-fun/bars-replay/v1.
// The design is deliberately minimal: one early full-size entry, one hard stop,
// one wide trailing stop, then hold to the end. Everything else is noise.
//
// Why this shape (measured on the dev window + 4 synthetic regimes, see BRIEF-v2.md):
//   - The dev window's money sits in ONE leg (hours 3-4, +313 bps) and then 19h
//     of chop. A bot that is IN the leg early and stays in wins; a bot that
//     churns the chop pays ~40 bps per round trip and bleeds.
//   - Filters that sound smart hurt here: the volatility squeeze adds nothing in
//     dev and loses -$42.61 in a down-mirror (vs -$14.75 without it); momentum
//     confirmation buys the top of the first burst (-$0.16 dev); EMA exits cut
//     legs short (+$1.11 dev); tight trails and fast stagnation exits free the
//     bot to re-enter chop sooner, which is where the money is lost.
//   - So: buy 100% of cash on the 25th scored bar (bar index 24), no signal
//     filter at all. The entry is early enough to catch any leg that follows,
//     and the two exits below bound the loss if the window falls instead:
//       * hard stop: sell everything if a close prints 100 bps below the entry
//         fill (a disaster guard; never triggered on the dev window).
//       * trailing stop: sell everything if a close prints 200 bps below the
//         highest close since entry (lets a leg run through its normal -198 bps
//         worst drawdown, exits a real reversal).
//     Kill switch: sell everything if equity falls below 96.5% of start
//     (never triggered in any tested regime; guards against fill gaps the
//     backtest cannot see).
//   - Measured (offline backtester mirroring the harness fill model exactly;
//     it reproduces v1 +$24.32, buy-and-hold +$32.17 and momentum +$34.94 to the
//     cent): DEV +$34.94 (1 trade, maxDD -197.8 bps, fees $0.81); split-half
//     +$30.72 / +$2.05 (both positive); down-mirror -$10.95; flat chop +$10.79;
//     time-reversed -$11.93; shuffled hours +$30.40. Worst case -$11.93,
//     mean +$10.7 across the five windows — vs v1's +$24.32 dev, -$42.61 worst,
//     +$0.1 mean. The v2 design beats v1 in 4 of 5 windows and on every summary
//     number, which is what justifies replacing a submitted entry.
//
// Everything is deterministic: indicators are pure functions of the bars seen,
// no wall clock, no randomness, no files, no network. Amounts on the wire are
// bigints; indicator math uses plain numbers (raw price units, ratios only).
// Fills are matched to the order that caused them by the deterministic
// client_id the SDK assigns at send time, never by decided_bar, which the
// protocol defines as the deciding batch's close time in ms, not its seq.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// One full-size entry on the 25th scored bar; no signal filter.
const ENTRY_BAR = 24; // zero-based index among scored bars (the 25th bar)
// Exits, in basis points of the entry fill / highest close since entry.
const HARD_STOP_BPS = 100; // sell all if a close prints this far below entry
const TRAIL_DIST_BPS = 200; // sell all if a close prints this far below the peak
const KILL_SWITCH_BPS = 350; // sell all if equity falls this far below start
const MAX_SLIPPAGE_BPS = 500; // 1-minute moves never approached this in validation

interface PendingOrder {
  side: 'buy' | 'sell';
  clientId: string;
}

class EarlyAnchor {
  private scoredBars = 0; // scored (non-warm-up) bars seen with a bar for CBBTC
  private bought = false; // the one entry order has been sent
  private inPosition = false;
  private entryFill = 0; // raw price units of the buy fill
  private highestClose = 0; // highest raw close since entry
  private pending: PendingOrder | null = null;
  private startEquity = 0n;

  onHello(state: BarsState): void {
    this.startEquity = BigInt(state.hello.capital.quote_units);
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] | void {
    // 1) Settle the order decided on the previous batch: its fill (or rejection)
    //    arrives in this batch. Match it by the client_id assigned when the order
    //    was sent — NOT by decided_bar: the protocol carries decided_bar as the
    //    batch's close time in ms (BarTime), not its seq, so comparing it with
    //    state.seq never matches and the fill is never seen.
    if (this.pending !== null) {
      const fill = batch.fills.find((f) => f.client_id === this.pending!.clientId && !f.client_id.startsWith('_'));
      if (fill !== undefined) {
        if (fill.status === 'filled') {
          if (fill.side === 'buy') {
            this.inPosition = true;
            this.entryFill = Number(fill.price);
            this.highestClose = this.entryFill;
            console.error(`buy filled bar=${state.seq} price=${this.entryFill}`);
          } else {
            this.inPosition = false;
            console.error(`sell filled bar=${state.seq} price=${Number(fill.price)}`);
          }
        } else {
          // Rejected (warmup / no_bar / max_slippage): the entry may be retried
          // on the next bar if it was the buy; a rejected sell leaves the
          // position open and the exit logic below retries it.
          if (this.pending.side === 'buy') this.bought = false;
        }
        this.pending = null;
      }
    }

    // 2) This batch's bar for our symbol (absent on a gap minute: nothing to decide).
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return;
    if (!state.warmingUp) this.scoredBars += 1;
    const c = Number(bar.c);

    // 3) Holding: hard stop, trailing stop, kill switch — all priced off closes,
    //    all filling at the next bar's open.
    if (this.inPosition) {
      if (c > this.highestClose) this.highestClose = c;
      const killLevel = (this.startEquity * BigInt(10000 - KILL_SWITCH_BPS)) / 10000n;
      const pos = state.positions.get(SYMBOL);
      if (pos !== undefined && pos.qty > 0n) {
        let reason: string | null = null;
        if (state.equity < killLevel) reason = 'killswitch';
        else if (c <= this.entryFill * (1 - HARD_STOP_BPS / 10000)) reason = 'hardstop';
        else if (c <= this.highestClose * (1 - TRAIL_DIST_BPS / 10000)) reason = 'trail';
        if (reason !== null && this.pending === null) {
          const sellId = state.clientId();
          this.pending = { side: 'sell', clientId: sellId };
          console.error(`sell signal bar=${state.seq} reason=${reason} close=${c} entry=${this.entryFill} peak=${this.highestClose}`);
          return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: sellId }];
        }
      }
      return;
    }

    // 4) The one entry: 100% of cash on the 25th scored bar, no filter.
    //    A rejected buy is retried on later bars (bought resets on rejection,
    //    and the window below stays open for 24 bars after the target bar);
    //    once filled, bought stays true and there is no second entry.
    if (!this.bought && !state.warmingUp && this.scoredBars >= ENTRY_BAR + 1 && this.scoredBars <= ENTRY_BAR + 25 && this.pending === null && state.cash > 0n) {
      this.bought = true;
      const buyId = state.clientId();
      this.pending = { side: 'buy', clientId: buyId };
      console.error(`buy signal bar=${state.seq} close=${c} cash=${state.cash}`);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: buyId }];
    }
  }
}

await runBars(new EarlyAnchor());
