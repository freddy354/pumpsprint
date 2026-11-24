// Early-flow launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The strategy lives in strategy.ts; this file only wires it to the harness. Run by the
// grader as `node /bot/main.ts` with this directory mounted at /bot.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Strategy: early-flow launch sniper — buy in the first 3 slots on strong early flow
// (net >= 0.5 SOL, >= 3 distinct buyers), exit on TP +5% / SL -8% / trailing -10% /
// max hold 60 slots. All parameters live in DEFAULT_PARAMS (strategy.ts).
await runBot(createStrategy(DEFAULT_PARAMS));
