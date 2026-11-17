# token-radar-01-v3

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/levikasep12/token-radar-01-v3/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/levikasep12/token-radar-01-v3/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it ranks pre-token DeFi protocols by an implied token value fitted from the live-token comparables in the sealed snapshot, and shows how to farm each one. The value model is a hierarchical comps fit — log market-cap-to-TVL against log TVL with shrunken per-category effects, an ensemble with a nearest-comps estimate — validated out of sample by leave-one-out and by a time split, with the validation numbers printed on the dashboard itself. Nothing is hardcoded by name: every number is fitted at runtime from the snapshot.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only, deterministic: two runs write the same bytes. Reads the sealed snapshot and writes the ranked board (`board.json`), the dashboard data, the dashboard page, screenshots and the dossier into the output directory.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4qtem8kg&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
