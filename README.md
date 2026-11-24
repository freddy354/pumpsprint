# Pump.fun Paper Sprint — Early-Flow Launch Sniper

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun.

## The strategy

A deterministic paper-trading bot for the pump.fun bonding-curve replay. It buys only in the first 3 slots after a coin's CreateEvent, and only when the opening tape shows strong early flow (net buy flow >= 0.5 SOL and >= 3 distinct non-creator buyers, dev buy <= 2 SOL, dev not sold, price not run up more than +25% from create). Positions are built up to 0.06 SOL per coin. Exits: take-profit +5%, stop-loss -8%, trailing stop -10% from peak (armed at +5%), max hold 60 slots, plus an immediate exit on a dev sell or a single sell >= 25% of real reserve. A pacing guardrail targets 30 coins per 6-hour window so the 20-coin minimum is met even in quiet windows.

Dev grade-local (process driver): net PnL +0.0319 SOL, 199 fills, 90 coins, 90 round trips, max drawdown 0.0050. Deterministic — the L1 regrade reproduced the action log byte for byte.

`main.ts` wires the strategy in `strategy.ts` to the harness (`vendor/makefun-bot.ts`, the kit's own SDK).

[![bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/freddy354/pumpsprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/freddy354/pumpsprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
