// Early-flow launch sniper for the pump.fun bonding-curve replay.
//
// Idea, from the dev window's own numbers (1222 in-universe coins, 24h):
//   - A coin's price spikes in its FIRST few slots and then fades: median price vs create is
//     +10.8% at +10 slots, +5.3% at +60, +1.0% at +300. Buying after slot ~10 is already late.
//   - The opening tape predicts the spike: coins with net buy flow >= 0.5 SOL and >= 2 distinct
//     non-creator buyers in their first 3 slots reach +10% above their slot+3 price within 300
//     slots 44% of the time (34% reach +20%); coins with net flow < 0.1 SOL almost never run
//     (0.6%). A dev sale inside the first 3 slots is a near-certain dud (6.8% reach +10%).
//   - So: buy only in the first 3 slots, only on strong early flow, size small, and exit on a
//     take-profit, a tight stop, or a trailing stop from the peak — never ride the fade.
//   - Fees set the bar: a round trip costs ~2.5% in curve fees plus two fixed tx fees, so
//     positions are built up to a size where the fixed fees stop mattering (~0.05-0.15 SOL).
//
// How it differs from the kit's sniper baseline: the entry filter is the measured early-flow
// signal (net SOL + distinct buyers, no cap on buyer count — the baseline caps buyers at 3,
// which throws away the best launches); positions are built up in adds as the reserve grows
// (the 1%-of-reserve cap makes the first buy tiny); exits add a trailing stop and a dev-sell /
// big-sell exit on top of take-profit / stop / max-hold.
//
// Deterministic by construction: a pure function of the batches the harness sends — no clock,
// no randomness, no I/O, iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may still be decided. */
  maxAge: number;
  /** Net buy SOL (buys minus sells) over the opening tape (slots since create <= maxAge). */
  minNetSol: number;
  /** Distinct non-creator buyers over the opening tape. */
  minBuyers: number;
  /** Creator's own buys over the opening tape: at most this many SOL (a huge dev buy is a dump setup). */
  maxDevBuy: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** First buy (SOL); the 1%-of-real-reserve cap applies on top. */
  initialSol: number;
  /** Each add-on buy (SOL); the cap applies on top. */
  addSol: number;
  /** Total SOL per coin (first buy + adds). */
  stakeSol: number;
  /** Smallest buy worth sending (a tx fee is 105k lamports per order). */
  minBuySol: number;
  /** An add needs the price at least this far above the last buy's decision price. */
  addStep: number;
  /** An add needs the net SOL flow over the last addFlowWindow slots at least this. */
  addFlowWindow: number;
  addMinFlow: number;
  /** Exit when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit when it falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm); exits on a fall of trail from the peak. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Exit at once when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Exit at once on a single recorded sell of at least this share of the real SOL reserve. */
  bigSellShare: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlippageBps: number;
  /** Most new entries per reply (exits and adds go first). */
  maxEntriesPerBatch: number;
  /** Skip an entry when the price already ran this far above the create price. */
  maxRunup: number;
  /** First take-profit: sell tp1Part of the position once it is worth tp1 over cost. */
  tp1: number;
  tp1Part: number;
  /** Exit when the net SOL flow over the last exitFlowWindow slots falls below -exitFlowSol. */
  exitFlowWindow: number;
  exitFlowSol: number;
  /**
   * Guardrail pacing: the run must end with at least 20 coins holding a round trip of 0.01 SOL.
   * When the coins traded so far lag paceTargetCoins prorated over paceSecs of block time, entries
   * loosen to looseMinBuyers and shrink to looseStakeSol — just enough to secure the bar, so a
   * quiet window still clears it while a busy window stays on the strict (higher-EV) filter.
   */
  paceTargetCoins: number;
  paceSecs: number;
  looseMinBuyers: number;
  looseStakeSol: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  minNetSol: 0.5,
  minBuyers: 3,
  maxDevBuy: 2,
  minRealSol: 0.3,
  maxRealSol: 30,
  initialSol: 0.015,
  addSol: 0.03,
  stakeSol: 0.06,
  minBuySol: 0.008,
  addStep: 0.02,
  addFlowWindow: 30,
  addMinFlow: 0,
  takeProfit: 0.05,
  stopLoss: 0.08,
  trailArm: 0.05,
  trail: 0.1,
  maxHold: 60,
  exitOnDevSell: true,
  bigSellShare: 0.25,
  buySlippageBps: 1500,
  maxEntriesPerBatch: 4,
  maxRunup: 0.25,
  tp1: 0.05,
  tp1Part: 0,
  exitFlowWindow: 15,
  exitFlowSol: 1000,
  paceTargetCoins: 30,
  paceSecs: 21600,
  looseMinBuyers: 2,
  looseStakeSol: 0.03,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125;
const BPS = 10_000;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  mint: Pubkey;
  created: number;
  creator: string;
  /** Price (vq/vt) at the CreateEvent. */
  createPrice: number;
  /** Opening-tape stats (trades with slot - created <= maxAge). */
  netSol: number;
  buySol: number;
  buyers: Set<string>;
  devBuy: number;
  devSold: boolean;
  /** Recent trades, for flow / big-sell detection. */
  recent: Tick[];
  /** Last trade slot seen. */
  lastTrade: number;
  /** Decided: bought, or filtered out for good. */
  decided: boolean;
  /** A sell is in flight for a position on this coin. */
  selling: boolean;
}

interface Held {
  opened: number;
  /** Best liquidation value seen (SOL), for the trailing stop. */
  peak: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** Total SOL this position may reach (the tier's stake). */
  stake: number;
  /** Decision price (vq/vt) of the last buy sent. */
  lastBuyPrice: number;
  /** Some buy of this position filled. */
  filled: boolean;
  /** The first take-profit already fired on this position. */
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees, in lamports. */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Distinct mints with at least one filled buy (the bot's own fills only). */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey, slot: number, creator: string, createPrice: number): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint, created: slot, creator, createPrice,
        netSol: 0, buySol: 0,
        buyers: new Set(), devBuy: 0, devSold: false,
        recent: [], lastTrade: slot, decided: false, selling: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL flow over the last `w` slots of a coin's recent tape. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= now - w) break;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      // The bot's own filled buys, for the guardrail pace.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
      }

      // 1. Fold this batch's events into the tapes.
      const fresh: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint, e.slot, e.creator, Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves));
          if (!fresh.includes(e.mint)) fresh.push(e.mint);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          // Cap the tape at 200 ticks: every flow window looks back at most 30 slots,
          // so anything older than that is dead weight for entry, add and exit decisions.
          if (c.recent.length > 200) c.recent.splice(0, c.recent.length - 200);
          c.lastTrade = e.slot;
          if (e.slot - c.created <= p.maxAge) {
            if (e.is_buy) {
              c.netSol += sol;
              c.buySol += sol;
              if (e.user === c.creator) c.devBuy += sol;
              else c.buyers.add(e.user);
            } else {
              c.netSol -= sol;
              if (e.user === c.creator) c.devSold = true;
            }
          } else if (!e.is_buy && e.user === c.creator) {
            c.devSold = true;
          }
          if (!fresh.includes(e.mint)) fresh.push(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.decided = true;
        }
      }

      // 2. Exits first, in held-insertion order (deterministic).
      for (const [mint, h] of held) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const value = Number(sellValueLamports(pos.token_amount, vq, vt)) / LAMPORTS - txSol;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        const c = coins.get(mint);
        // First take-profit: bank part of the position, let the rest ride the tail.
        if (!h.tookTp1 && cost > 0 && value >= cost * (1 + p.tp1) && p.tp1Part > 0 && p.tp1Part < 1) {
          const part = (pos.token_amount * BigInt(Math.round(p.tp1Part * 10000))) / 10000n;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            h.tookTp1 = true;
            h.peak = 0;
            const cc = coins.get(mint);
            if (cc !== undefined) cc.selling = true;
            continue;
          }
        }
        let exit = false;
        if (cost > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && cost > 0 && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value <= h.peak * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened >= p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && c !== undefined && c.devSold) exit = true;
        if (!exit && c !== undefined && flow(c, now, p.exitFlowWindow) < -p.exitFlowSol) exit = true;
        if (!exit && c !== undefined) {
          const rq = Number(curve.real_quote_reserves) / LAMPORTS;
          for (let i = c.recent.length - 1; i >= 0; i--) {
            const t = c.recent[i]!;
            if (t.slot < now - 2) break;
            if (!t.isBuy && t.sol >= rq * p.bigSellShare && rq > 0) {
              exit = true;
              break;
            }
          }
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        const cc = coins.get(mint);
        if (cc !== undefined) cc.selling = true;
      }

      // 3. Adds: build a position up toward stakeSol while it rises on fresh flow.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      for (const [mint, h] of held) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const c = coins.get(mint);
        if (c === undefined || c.selling) continue;
        if (h.invested >= h.stake - p.minBuySol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
        if (flow(c, now, p.addFlowWindow) < p.addMinFlow) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(p.addSol, capSol, h.stake - h.invested);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        free -= amount + txSol;
        h.invested += amount;
        h.lastBuyPrice = price;
        pendingByMint.set(mint, (pendingByMint.get(mint) ?? 0) + 1);
      }

      // 4. Entries: first batch where the opening tape passes, age <= maxAge.
      // Guardrail pace: loosen to the small-stake tier while the traded-coin count lags.
      let committed = myCoins.size;
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy' && !myCoins.has(po.order.mint)) pendingMints.add(po.order.mint);
      }
      committed += pendingMints.size;
      const pace = firstTime === null || lastTime === null ? 0 : Math.min(1, (lastTime - firstTime) / p.paceSecs);
      const needMore = committed < Math.ceil(p.paceTargetCoins * pace);
      const minBuyers = needMore ? p.looseMinBuyers : p.minBuyers;
      const stake = needMore ? p.looseStakeSol : p.stakeSol;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let entries = 0;
      for (const mint of fresh) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch || slotsLeft <= 0) break;
        const c = coins.get(mint);
        const curve = state.curves.get(mint);
        if (c === undefined || curve === undefined || curve.complete) continue;
        if (c.decided || state.positions.has(mint) || pendingByMint.has(mint)) continue;
        const age = now - c.created;
        if (age > p.maxAge) {
          c.decided = true;
          continue;
        }
        if (c.netSol < p.minNetSol || c.buyers.size < minBuyers) continue;
        if (c.devBuy > p.maxDevBuy || c.devSold) continue;
        const price0 = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (c.createPrice > 0 && price0 > c.createPrice * (1 + p.maxRunup)) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(p.initialSol, capSol);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        free -= amount + txSol;
        c.decided = true;
        held.set(mint, { opened: now, peak: 0, invested: amount, stake, lastBuyPrice: price, filled: false, tookTp1: false });
        pendingByMint.set(mint, (pendingByMint.get(mint) ?? 0) + 1);
        entries++;
        slotsLeft--;
      }

      // 5. A coin whose window closed without a buy is done for good.
      for (const mint of fresh) {
        const c = coins.get(mint);
        if (c !== undefined && !c.decided && now - c.created > p.maxAge) c.decided = true;
      }
      return orders;
    },
  };
}
