[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/icandoitone/makefun-token-radar-01-03/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard)
[![reward](https://make.fun/badge/token-radar-01/icandoitone/makefun-token-radar-01-03/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — comps-fit-1

Which pre-token protocol is worth farming next — priced by the market, not by a list.

This entry reads the sealed DefiLlama snapshot (758 protocols, 40 on the watchlist),
fits a launch-pricing model on the protocols whose tokens already trade, and ranks
every pre-token protocol by what its token would be worth at launch. The dashboard
shows the board, the fitted model and its out-of-sample test, the traded tokens as
anchors, and a costed farm plan for every row.

## The model

`comps-fit-1` is a log-log OLS fit on the traded protocols (market cap > 0):

```
ln(implied value) = b0 + b1 · ln(TVL) + b2 · growth_7d + b3 · ln(1 + age_days) + b4 · ln(chains)
```

The coefficients are learned from the market, not set by hand. The same fit scores
every protocol — no name is ever special-cased.

## Tested out of sample

- **Leave-one-out:** each traded protocol is held out in turn, the model is refitted
  without it, and the held-out market cap is predicted. The dashboard reports the
  median absolute error and the share predicted within 2×.
- **200 bootstrap refits:** the traded set is resampled, the model is refitted, and
  every pre-token protocol is priced again. The 10th–90th percentile is the value
  range on each row; the rank range is where the protocol would sit at either end.

## The board

- 198 pre-token protocols in the snapshot, ranked by fitted implied value —
  the watchlist (40) is the floor, never the ceiling. (342 protocols record no
  token; the board sets aside exchanges, bridges, liquid-staking and restaked
  products, wrapped/staked names, versioned pools and exchange-named protocols,
  under the snapshot's own watchlist rule — those are not launches of their own.)
- Every row carries a value range, a rank range and a costed farm plan: the deposit
  is sized by the protocol's TVL, and every step states its gas and its time.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22, standard library only. The run is deterministic: the same snapshot bytes
always produce the same bytes out.

## Layout

- `main.ts` — entrypoint
- `lib/fit.ts` — OLS, leave-one-out, bootstrap refits
- `lib/board.ts` — snapshot parsing, board building, farm plans
- `vendor/makefun-board.ts` — the dossier library, the kit's copy byte for byte
- `dashboard/` — index.html + app.css + app.js, no network
- `screenshots/` — board, detail view, filtered view
