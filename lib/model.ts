// Token Launch Radar — radar-4: a robust comps-fitted value model.
//
// The model prices every pre-token protocol from the live-token comparables in
// the sealed snapshot. It fits, at runtime and from the snapshot alone:
//
//   log10(mcap / TVL) = level + sizeSlope x (log10 TVL - 8)
//                       + chainsCoef x (min(chains, 5) - 1)
//                       + family effect (shrunk toward 0)
//
// The fit is Huber-robust (iteratively reweighted least squares, c = 1.0, MAD
// scale), so a few broken or near-dead records cannot drag the line. The
// family effect is each category's mean residual, shrunk by n / (n + 10).
// Growth and age enter as separate multiplicative factors, so the dashboard
// can show the arithmetic for every row:
//
//   implied = TVL x 10^pred x growthFactor x ageFactor
//
// Nothing is hardcoded by name: every number is fitted from the snapshot at
// run time, and the validation numbers below are computed at run time too
// (leave-one-out, a time split, 5-fold cross-validation, bootstrap).

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  tvl_usd: number;
  category: string;
  chains: string[];
  change_7d: number | null;
  age_days: number;
  multiple: number;
  growth_factor: number;
  age_factor: number;
  family_effect: number;
  implied_low_usd: number;
  implied_high_usd: number;
  capital_usd: number;
  hold_days: number;
  gas_usd: number;
  airdrop_per_1k_usd: number;
  expected_airdrop_usd: number;
  farm_net_usd: number;
  break_even_usd: number;
  watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface AsideRow {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  reason: string;
}

export interface ModelInfo {
  name: string;
  level: number;
  sizeSlope: number;
  chainsCoef: number;
  comps: number;
  families: number;
  clipLo: number;
  clipHi: number;
  huberC: number;
  shrinkK: number;
  bandLo: number;
  bandHi: number;
}

export interface ValidationInfo {
  loo: number;
  flatLoo: number;
  oos: number;
  oosTrain: number;
  oosTest: number;
  cv5: number;
  pipe: number;
  slopeP5: number;
  slopeP95: number;
  chainsP5: number;
  chainsP95: number;
}

export interface RadarData {
  asOf: string;
  model: ModelInfo;
  validation: ValidationInfo;
  rows: BoardRow[];
  live: LiveRow[];
  aside: AsideRow[];
  earlySize: number;
  liveSize: number;
  asideSize: number;
  totalImplied: number;
  watchlistCount: number;
}

/** Categories whose tokens are not launches to come: excluded from the comps and the board. */
const EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Exchange names: a protocol starting with one is an exchange product, not a launch. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker (V2, v3, 2.0) is a version, not a protocol. */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** The comps' target is clipped to this log10 range: below it sit dead-token records. */
const CLIP_LO = -2.5;
const CLIP_HI = 1.0;

/** Huber constant and IRLS rounds for the robust fit. */
const HUBER_C = 1.0;
const HUBER_ROUNDS = 5;

/** Family shrinkage: a family's effect is its mean residual times n / (n + K). */
const SHRINK_K = 10;

/** The time split's cut: comps listed before it train, the rest test. */
const OOS_CUT = '2024-06-01';

/** The airdrop assumption behind every farm plan's expected value. */
const AIRDROP_SHARE = 0.075;

const DAY_MS = 86_400_000;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A small deterministic hash for the cross-validation folds (FNV-1a). */
function slugHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A seeded linear congruential generator for the bootstrap (deterministic). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

/** Parse and minimally validate the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: expected an object with protocols and watchlist arrays');
  }
  for (const p of raw.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error('snapshot: a protocol is missing slug, name or tvl_usd');
    }
    if (!Array.isArray(p.chains)) p.chains = [];
  }
  return raw;
}

/** Days from the protocol's first listing to the snapshot date; 365 when unknown. */
function ageDays(p: Protocol, asOfMs: number): number {
  if (!p.listed_at) return 365;
  const listed = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (!Number.isFinite(listed)) return 365;
  return Math.max(0, (asOfMs - listed) / DAY_MS);
}

/** The size regressor: log10 TVL centred on $100M. */
function sizeVar(p: Protocol): number {
  return Math.log10(p.tvl_usd) - 8;
}

/** The breadth regressor: chain count capped at 5, so one chain scores 0. */
function chainsVar(p: Protocol): number {
  return Math.min(p.chains.length, 5) - 1;
}

/** The fit's target: the log10 multiple, clipped to the sane range. */
function fitTarget(p: Protocol): number {
  return clamp(Math.log10(p.mcap_usd! / p.tvl_usd), CLIP_LO, CLIP_HI);
}

/** The comparables: live-token protocols outside the excluded families, with a usable multiple. */
function selectComps(snapshot: Snapshot): Protocol[] {
  return snapshot.protocols.filter((p) => {
    if (p.mcap_usd === null || p.mcap_usd <= 0) return false;
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
    return p.mcap_usd / p.tvl_usd <= 10;
  });
}

/**
 * Solve a small dense linear system by Gaussian elimination with partial
 * pivoting. A whisper of ridge keeps a near-singular matrix solvable.
 */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r;
    const tmp = m[c]!;
    m[c] = m[pivot]!;
    m[pivot] = tmp;
    if (Math.abs(m[c]![c]!) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** Weighted least squares for a design matrix, via the normal equations. */
function weightedOls(design: number[][], y: number[], weights: number[]): number[] {
  const d = design[0]!.length;
  const ata: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const atb: number[] = new Array<number>(d).fill(0);
  for (let i = 0; i < design.length; i++) {
    const w = weights[i]!;
    for (let j = 0; j < d; j++) {
      atb[j]! += w * design[i]![j]! * y[i]!;
      for (let k = 0; k < d; k++) ata[j]![k]! += w * design[i]![j]! * design[i]![k]!;
    }
  }
  for (let j = 0; j < d; j++) ata[j]![j]! += 1e-9;
  return solveLinear(ata, atb);
}

interface Fit {
  level: number;
  sizeSlope: number;
  chainsCoef: number;
  family: Map<string, number>;
}

/**
 * Fit the comps model: a Huber-robust line in size and chain breadth, then
 * shrunk per-category effects on the residuals. Deterministic: the same rows
 * always give the same fit.
 */
function fitModel(rows: Protocol[]): Fit {
  const design = rows.map((p) => [1, sizeVar(p), chainsVar(p)]);
  const y = rows.map(fitTarget);
  let weights = rows.map(() => 1);
  let beta = [0, 0, 0];
  for (let round = 0; round < HUBER_ROUNDS; round++) {
    beta = weightedOls(design, y, weights);
    const residuals = rows.map(
      (p, i) => y[i]! - (beta[0]! + beta[1]! * design[i]![1]! + beta[2]! * design[i]![2]!),
    );
    const centre = median(residuals);
    const scale = 1.4826 * median(residuals.map((r) => Math.abs(r - centre))) || 1;
    weights = residuals.map((r) => Math.min(1, (HUBER_C * scale) / Math.max(Math.abs(r), 1e-9)));
  }
  const base = (p: Protocol): number => beta[0]! + beta[1]! * sizeVar(p) + beta[2]! * chainsVar(p);
  const byFamily = new Map<string, number[]>();
  for (const p of rows) {
    const key = p.category ?? '(none)';
    const list = byFamily.get(key) ?? [];
    list.push(fitTarget(p) - base(p));
    byFamily.set(key, list);
  }
  const family = new Map<string, number>();
  for (const [key, residuals] of byFamily) {
    family.set(key, mean(residuals) * (residuals.length / (residuals.length + SHRINK_K)));
  }
  return { level: beta[0]!, sizeSlope: beta[1]!, chainsCoef: beta[2]!, family };
}

/** The fitted log10 multiple for a protocol, family effect included. */
function predictLogMultiple(fit: Fit, p: Protocol): number {
  return (
    fit.level +
    fit.sizeSlope * sizeVar(p) +
    fit.chainsCoef * chainsVar(p) +
    (fit.family.get(p.category ?? '(none)') ?? 0)
  );
}

/** The growth factor: half the seven-day TVL change, clamped to [-60%, +120%]. */
function growthFactor(p: Protocol): number {
  const change = p.change_7d === null ? 0 : clamp(p.change_7d, -60, 120);
  return 1 + 0.5 * (change / 100);
}

/** The age factor: 0.6 for a brand-new protocol, rising to 1.0 at three years. */
function ageFactor(p: Protocol, asOfMs: number): number {
  return 0.6 + 0.4 * (Math.min(ageDays(p, asOfMs), 1095) / 1095);
}

/** The implied token value: TVL times the fitted multiple, growth and age. */
function impliedValue(fit: Fit, p: Protocol, asOfMs: number): number {
  const value = p.tvl_usd * Math.pow(10, predictLogMultiple(fit, p)) * growthFactor(p) * ageFactor(p, asOfMs);
  return Math.max(1, Math.round(value));
}

/** The "typical factor off" metric: 10 to the mean absolute log10 error. */
function factorOff(errors: number[]): number {
  return Math.pow(10, mean(errors.map((e) => Math.abs(e))));
}

/**
 * Leave-one-out validation on the comps: each protocol is predicted by a fit
 * that never saw it. Also returns the flat-median baseline on the same test.
 */
function leaveOneOut(comps: Protocol[]): { loo: number; flat: number; residuals: number[] } {
  const errors: number[] = [];
  const flatErrors: number[] = [];
  const residuals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const held = comps[i]!;
    const fit = fitModel(train);
    const err = predictLogMultiple(fit, held) - fitTarget(held);
    errors.push(err);
    residuals.push(err);
    const others = train.map(fitTarget);
    flatErrors.push(median(others) - fitTarget(held));
  }
  return { loo: factorOff(errors), flat: factorOff(flatErrors), residuals };
}

/** The time split: fit on comps listed before the cut, test on the rest. */
function timeSplit(comps: Protocol[]): { oos: number; train: number; test: number } {
  const dated = comps.filter((p) => p.listed_at !== null);
  const train = dated.filter((p) => p.listed_at! < OOS_CUT);
  const test = dated.filter((p) => p.listed_at! >= OOS_CUT);
  const fit = fitModel(train);
  const errors = test.map((p) => predictLogMultiple(fit, p) - fitTarget(p));
  return { oos: factorOff(errors), train: train.length, test: test.length };
}

/** Seeded 5-fold cross-validation, folds cut by a hash of the slug. */
function fiveFold(comps: Protocol[]): number {
  const order = comps.map((_, i) => i).sort((a, b) => slugHash(comps[a]!.slug) - slugHash(comps[b]!.slug));
  const errors: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const heldIdx = order.filter((_, j) => j % 5 === fold);
    const heldSlugs = new Set(heldIdx.map((i) => comps[i]!.slug));
    const train = comps.filter((p) => !heldSlugs.has(p.slug));
    const fit = fitModel(train);
    for (const i of heldIdx) {
      errors.push(predictLogMultiple(fit, comps[i]!) - fitTarget(comps[i]!));
    }
  }
  return factorOff(errors);
}

/** Full-pipeline leave-one-out: the fitted multiple times growth and age. */
function pipelineLoo(comps: Protocol[], asOfMs: number): number {
  const errors: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const held = comps[i]!;
    const fit = fitModel(train);
    const predicted =
      predictLogMultiple(fit, held) + Math.log10(growthFactor(held) * ageFactor(held, asOfMs));
    errors.push(predicted - fitTarget(held));
  }
  return factorOff(errors);
}

/** Bootstrap ranges for the two slopes: 200 resamples from a seeded generator. */
function bootstrapSlopes(comps: Protocol[]): { slopeP5: number; slopeP95: number; chainsP5: number; chainsP95: number } {
  const next = lcg(20261114);
  const slopes: number[] = [];
  const chains: number[] = [];
  for (let b = 0; b < 200; b++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(next() * comps.length)]!);
    const fit = fitModel(sample);
    slopes.push(fit.sizeSlope);
    chains.push(fit.chainsCoef);
  }
  slopes.sort((a, b) => a - b);
  chains.sort((a, b) => a - b);
  const at = (xs: number[], q: number): number => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
  return { slopeP5: at(slopes, 0.05), slopeP95: at(slopes, 0.95), chainsP5: at(chains, 0.05), chainsP95: at(chains, 0.95) };
}

/** A quartile of sorted numbers, by linear interpolation. */
function quartile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Estimated gas per transaction in USD, by chain. Estimates, not quotes. */
const GAS_USD: Record<string, number> = {
  Ethereum: 8,
  Arbitrum: 0.4,
  Base: 0.15,
  Optimism: 0.3,
  Binance: 0.25,
  Solana: 0.05,
  Polygon: 0.1,
  Avalanche: 0.5,
  Monad: 0.05,
  'Hyperliquid L1': 0.05,
  Plasma: 0.1,
  'Robinhood Chain': 0.05,
  Berachain: 0.1,
  Unichain: 0.1,
  Sonic: 0.05,
  Flare: 0.05,
  'Plume Mainnet': 0.05,
  Arc: 0.1,
  Katana: 0.1,
  Bitcoin: 2,
};

function gasPerTx(chain: string): number {
  return GAS_USD[chain] ?? 1;
}

/** The farming capital tier for a protocol, from its TVL. */
function capitalTier(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 250;
  if (tvlUsd >= 250_000_000) return 200;
  if (tvlUsd >= 100_000_000) return 150;
  if (tvlUsd >= 50_000_000) return 100;
  return 50;
}

/** The holding period for a protocol, from how long it has run. */
function holdDays(age: number): number {
  if (age >= 730) return 60;
  if (age >= 365) return 45;
  return 30;
}

/** What farming means for each kind of protocol: a main action and a follow-up. */
const MECHANISMS: Record<string, [string, string]> = {
  'Risk Curators': [
    'deposit into a curator vault and hold the receipt token',
    'spread a second deposit across another vault to diversify curator risk',
  ],
  Dexs: [
    'provide liquidity to a core pool and hold the LP position',
    'stake the LP tokens if the pool offers rewards',
  ],
  'Onchain Capital Allocator': [
    'allocate capital to the allocator vault',
    'rebalance toward the highest-yield sleeve once a month',
  ],
  Lending: [
    'supply collateral and borrow a small amount against it',
    'repay part of the loan to keep the health factor high',
  ],
  RWA: [
    'buy into a tokenized real-world-asset pool',
    'reinvest the yield the pool distributes',
  ],
  Yield: [
    'deposit into the highest-yield vault and hold',
    'compound the yield back into the vault each week',
  ],
  Derivatives: [
    'open a small hedged position on the venue',
    'roll the position before expiry',
  ],
  CDP: [
    'lock collateral and mint the protocol stablecoin',
    'keep the collateral ratio above the safe line',
  ],
  'Yield Aggregator': [
    'deposit into the auto-compounding vault',
    'let the vault compound and top the position up monthly',
  ],
  'Basis Trading': [
    'enter the basis trade the desk runs',
    'watch the funding rate and exit if it flips negative',
  ],
  Chain: [
    'bridge funds to the chain and use its native apps',
    'stake the chain gas token if staking is live',
  ],
  'Staking Pool': [
    'stake into the pool and hold the receipt token',
    'restake the rewards back into the pool',
  ],
  'Liquidity Manager': [
    'deposit into a managed liquidity vault',
    'let the manager rebalance and check the range monthly',
  ],
  Restaking: [
    'restake liquid staking tokens through the protocol',
    'track restaking points and operator performance',
  ],
  'Leveraged Farming': [
    'open a leveraged farm position with modest leverage',
    'watch the health factor daily and deleverage on drops',
  ],
};

function mechanism(category: string): [string, string] {
  return MECHANISMS[category] ?? ['use the core product with a real position', 'return weekly and grow the position if it performs'];
}

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 10) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Build one protocol's seven-step farm plan. Every step names its cost and
 * its time, and the plan's economics (expected airdrop, net, break-even)
 * come from the stated 7.5% airdrop assumption.
 */
function farmPlan(p: Protocol, implied: number, asOfMs: number): { steps: string[]; economics: Omit<BoardRow, 'slug' | 'name' | 'rank' | 'implied_value_usd' | 'farm_steps' | 'tvl_usd' | 'category' | 'chains' | 'change_7d' | 'age_days' | 'multiple' | 'growth_factor' | 'age_factor' | 'family_effect' | 'implied_low_usd' | 'implied_high_usd' | 'watchlist'> } {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasPerTx(chain);
  const txCount = 5;
  const totalGas = gas * txCount;
  const capital = capitalTier(p.tvl_usd);
  const age = ageDays(p, asOfMs);
  const hold = holdDays(age);
  const [main, followUp] = mechanism(p.category ?? '');
  const cat = p.category ?? 'DeFi';
  const expected = (capital * implied * AIRDROP_SHARE) / p.tvl_usd;
  const per1k = (1000 * implied * AIRDROP_SHARE) / p.tvl_usd;
  const net = expected - totalGas;
  const breakEven = (totalGas * p.tvl_usd) / Math.max(1, implied * AIRDROP_SHARE);
  const steps = [
    `Verify ${p.name} still records no token: read its docs and announcements, and confirm the ${cat} product is live on ${chain}. Cost $0. Time 30 min.`,
    `Set up a wallet on ${chain} and fund it with ${money(capital)} plus ${money(totalGas)} for gas across the plan. Cost ${money(gas)}. Time 15 min.`,
    `Bridge or deposit ${money(capital)} to ${chain} if your funds sit elsewhere, and keep a little native gas aside for later steps. Cost ${money(gas)}. Time 20 min.`,
    `Take the main position: ${main}, starting with ${money(capital)} on ${chain}. Cost ${money(gas)} plus capital. Time 20 min.`,
    `Deepen the position: ${followUp}. Cost ${money(gas)}. Time 20 min.`,
    `Hold for ${hold} days and check eligibility weekly: points usually accrue by time-weighted balance, so early exits cost more than they save. Cost $0. Time 10 min a week.`,
    `Claim or exit: if a token is announced, claim through the official app and weigh holding against selling; if nothing is announced by day ${hold}, reassess and withdraw. Cost ${money(gas)}. Time 30 min.`,
  ];
  return {
    steps,
    economics: {
      capital_usd: capital,
      hold_days: hold,
      gas_usd: totalGas,
      airdrop_per_1k_usd: Math.round(per1k * 100) / 100,
      expected_airdrop_usd: Math.round(expected * 100) / 100,
      farm_net_usd: Math.round(net * 100) / 100,
      break_even_usd: Math.round(breakEven),
    },
  };
}

/** Is this protocol a launch the radar ranks: pre-token and not a wrapped, staked or bridged product? */
function isRankable(p: Protocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return !EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix));
}

/** Why a pre-token protocol is set aside, in the board's own words. */
function asideReason(p: Protocol): string {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    if (p.category === 'CEX') return 'Centralized exchange: its token, if any, is an exchange token, not a protocol launch.';
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge' || p.category === 'Cross Chain Bridge') {
      return 'Bridge: it moves other tokens between chains rather than launching one of its own.';
    }
    return 'Liquid staking family: its token is the receipt for staked assets, not a launch to come.';
  }
  if (VERSION_MARKER.test(p.name)) return 'Versioned name: this is one version of a protocol, not the protocol itself.';
  if (WRAPPED_WORD.test(p.name)) return 'Wrapped or staked product: the underlying token already trades.';
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) {
    return 'Exchange product: it carries an exchange name, not a protocol of its own.';
  }
  return 'Not rankable under the board rule.';
}

/** Build the whole radar: fit the model, validate it, score the board. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOfMs = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  const comps = selectComps(snapshot);
  const fit = fitModel(comps);

  // Validation, all computed from the comps at run time.
  const loo = leaveOneOut(comps);
  const split = timeSplit(comps);
  const cv = fiveFold(comps);
  const pipe = pipelineLoo(comps, asOfMs);
  const boot = bootstrapSlopes(comps);
  const sortedResiduals = [...loo.residuals].sort((a, b) => a - b);
  const bandLo = Math.pow(10, quartile(sortedResiduals, 0.25));
  const bandHi = Math.pow(10, quartile(sortedResiduals, 0.75));
  const families = new Set(comps.map((p) => p.category ?? '(none)')).size;

  const watchlist = new Set(snapshot.watchlist);
  const rankable = snapshot.protocols.filter(isRankable);
  const rows: BoardRow[] = rankable.map((p) => {
    const implied = impliedValue(fit, p, asOfMs);
    const plan = farmPlan(p, implied, asOfMs);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: plan.steps,
      tvl_usd: p.tvl_usd,
      category: p.category ?? 'Uncategorized',
      chains: p.chains,
      change_7d: p.change_7d,
      age_days: Math.round(ageDays(p, asOfMs)),
      multiple: Math.pow(10, predictLogMultiple(fit, p)),
      growth_factor: growthFactor(p),
      age_factor: ageFactor(p, asOfMs),
      family_effect: fit.family.get(p.category ?? '(none)') ?? 0,
      implied_low_usd: Math.max(1, Math.round(implied * bandLo)),
      implied_high_usd: Math.max(1, Math.round(implied * bandHi)),
      ...plan.economics,
      watchlist: watchlist.has(p.slug),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: p.mcap_usd! / p.tvl_usd,
    }));

  const aside: AsideRow[] = snapshot.protocols
    .filter((p) => p.gecko_id === null && p.symbol === null && !isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorized',
      tvl_usd: p.tvl_usd,
      reason: asideReason(p),
    }));

  const radar: RadarData = {
    asOf: snapshot.as_of,
    model: {
      name: 'radar-4',
      level: fit.level,
      sizeSlope: fit.sizeSlope,
      chainsCoef: fit.chainsCoef,
      comps: comps.length,
      families,
      clipLo: CLIP_LO,
      clipHi: CLIP_HI,
      huberC: HUBER_C,
      shrinkK: SHRINK_K,
      bandLo,
      bandHi,
    },
    validation: {
      loo: loo.loo,
      flatLoo: loo.flat,
      oos: split.oos,
      oosTrain: split.train,
      oosTest: split.test,
      cv5: cv,
      pipe,
      slopeP5: boot.slopeP5,
      slopeP95: boot.slopeP95,
      chainsP5: boot.chainsP5,
      chainsP95: boot.chainsP95,
    },
    rows,
    live,
    aside,
    earlySize: rows.filter((r) => !r.watchlist).length,
    liveSize: live.length,
    asideSize: aside.length,
    totalImplied: rows.reduce((sum, r) => sum + r.implied_value_usd, 0),
    watchlistCount: snapshot.watchlist.length,
  };
  return { board: rows, radar };
}

/** The gate's own shape, checked before anything is written: a reason, or null when the board is valid. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, need 100 to 4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (!slugs.has(row.slug)) return `row ${i + 1} names ${row.slug}, not a snapshot protocol`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (!row.name) return `row ${i + 1} has an empty name`;
    if (row.rank !== i + 1) return `row ${i + 1} carries rank ${row.rank}, need ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) {
      return `row ${row.slug} has an implied value of ${row.implied_value_usd}`;
    }
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${row.slug} is worth more than the row above it`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} has ${row.farm_steps.length} farm steps, need 3 to 12`;
    }
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters, need 20 to 600`;
    }
  }
  const values = new Set(board.map((r) => r.implied_value_usd));
  if (board.length >= 2 && values.size === 1) return 'every row carries the same implied value';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data as a script: one global, deterministic bytes. */
export function dataScript(radar: RadarData): string {
  return `// Token Launch Radar data. Generated by main.ts from the sealed snapshot; deterministic.\nwindow.RADAR = ${JSON.stringify(radar)};\n`;
}
