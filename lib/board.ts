// Board builder: reads the sealed snapshot, fits the comps model on the traded
// protocols, prices every pre-token protocol, validates the fit out of sample,
// and writes the board the dashboard renders. Every number on the board traces
// back to the snapshot's own figures — no name is ever special-cased.

import { bootstrapRanges, leaveOneOut, ols, predictOne } from './fit.ts';

/** One protocol as the snapshot records it. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  growth7d: number | null;
  mcap: number | null;
  listedAt: string | null;
  gecko: string | null;
  symbol: string | null;
}

/** The snapshot document. */
export interface Snap {
  asOf: string;
  source: string;
  floor: number;
  protos: Proto[];
  watch: string[];
}

/** One ranked board row. */
export interface Row {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  growth7d: number | null;
  listedAt: string | null;
  ageDays: number | null;
  implied: number;
  valueLow: number;
  valueHigh: number;
  rankLow: number;
  rankHigh: number;
  tvlMultiple: number;
  steps: string[];
}

/** One traded protocol used to anchor the fit. */
export interface Anchor {
  slug: string;
  name: string;
  category: string | null;
  tvl: number;
  mcap: number;
  fitted: number;
  multiple: number;
}

/** The fitted model as the dashboard states it. */
export interface ModelCard {
  version: string;
  features: string[];
  weights: number[];
  rSquared: number;
  trainedOn: number;
  looMedianErr: number;
  looWithin2x: number;
  looWithin15pct: number;
  refits: number;
  refitsKept: number;
  ridge: number;
  categories: string[];
}

/** Everything the dashboard renders. */
export interface BoardData {
  asOf: string;
  floor: number;
  model: ModelCard;
  watch: string[];
  watchCount: number;
  boardCount: number;
  preTokenCount: number;
  tradedCount: number;
  universeCount: number;
  rows: Row[];
  anchors: Anchor[];
}

export const MODEL_VERSION = 'comps-fit-1';
export const REFITS = 200;
export const REFIT_SEED = 20261118;
export const RIDGE = 1;

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`; null when either side is missing or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted-or-not number list. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Clamp a growth print into the band the model trusts. */
function clampGrowth(g: number | null): number {
  if (g === null || !Number.isFinite(g)) return 0;
  return Math.min(150, Math.max(-50, g));
}

/** The five features the fit learns on, plus one dummy per big category. */
export function featureRow(p: Proto, asOf: string, medianAge: number, cats: string[] = []): number[] {
  const age = ageInDays(asOf, p.listedAt) ?? medianAge;
  const row = [
    1,
    Math.log(Math.max(1, p.tvl)),
    clampGrowth(p.growth7d) / 100,
    Math.log(1 + Math.max(0, age)),
    Math.log(Math.max(1, p.chains.length)),
  ];
  for (const c of cats) row.push(p.category === c ? 1 : 0);
  return row;
}

export const FEATURE_NAMES = [
  'intercept',
  'ln(TVL)',
  'growth_7d',
  'ln(1 + age_days)',
  'ln(chains)',
];

/** Categories with enough traded comps to earn their own dummy. */
export function bigCategories(traded: Proto[], minMembers = 5): string[] {
  const counts = new Map<string, number>();
  for (const p of traded) {
    const c = p.category ?? 'Uncategorised';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minMembers)
    .map(([c]) => c)
    .sort();
}

/** A protocol the snapshot says records no token at all. */
export function isPreToken(p: Proto): boolean {
  return p.mcap === null && p.gecko === null && p.symbol === null;
}

/** A protocol the board may rank: pre-token and a genuine launch candidate, under
 * the snapshot's own watchlist rule — not an exchange, not a bridge, not a
 * staked/wrapped product of a token that already trades, not a versioned pool,
 * and not named after an exchange. The watchlist is built by this rule, so all
 * forty of its protocols pass it. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const NOT_A_LAUNCH = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
export function isRankable(p: Proto): boolean {
  return (
    isPreToken(p) &&
    !NOT_A_LAUNCH.has(p.category ?? '') &&
    !VERSIONED_NAME.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_NAME.test(p.name)
  );
}

/** Parse the snapshot text, refusing anything that is not its shape. */
export function parseSnap(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new Error('snapshot.json has no as_of date');
  }
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new Error('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols) || !Array.isArray(o.watchlist)) {
    throw new Error('snapshot.json has no protocols or watchlist array');
  }
  const protos = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new Error(`protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl: p.tvl_usd,
      growth7d:
        typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap:
        typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listedAt:
        typeof p.listed_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.listed_at)
          ? p.listed_at
          : null,
      gecko: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    } as Proto;
  });
  return {
    asOf: o.as_of,
    source: typeof o.source === 'string' ? o.source : '',
    floor: o.floor_usd,
    protos,
    watch: (o.watchlist as unknown[]).filter((s): s is string => typeof s === 'string'),
  };
}

/** Build the board and everything the dashboard shows, from one snapshot. */
export function buildAll(snap: Snap): BoardData {
  const bySlug = new Map(snap.protos.map((p) => [p.slug, p]));
  const traded = snap.protos.filter((p) => p.mcap !== null && p.mcap > 0 && p.tvl > 0);
  const ages = traded
    .map((p) => ageInDays(snap.asOf, p.listedAt))
    .filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? median(ages) : 365;
  const cats = bigCategories(traded);

  const trainX = traded.map((p) => featureRow(p, snap.asOf, medianAge, cats));
  const trainY = traded.map((p) => Math.log(p.mcap!));
  const fit = ols(trainX, trainY, RIDGE);
  if (fit === null) throw new Error('the comps fit is singular on this snapshot');
  const validation = leaveOneOut(trainX, trainY, traded.map((p) => p.slug), RIDGE);

  const rankable = snap.protos.filter(isRankable);
  const watchSet = new Set(snap.watch);
  for (const slug of snap.watch) {
    const p = bySlug.get(slug);
    if (p !== undefined && !rankable.includes(p)) rankable.push(p);
  }
  const predRows = rankable.map((p) => featureRow(p, snap.asOf, medianAge, cats));
  const { low, high, kept } = bootstrapRanges(trainX, trainY, predRows, REFITS, REFIT_SEED, RIDGE);

  const scored = rankable.map((p, i) => {
    const implied = Math.max(1, Math.round(Math.exp(predictOne(fit.weights, predRows[i]!))));
    return { p, implied, lo: Math.max(1, Math.round(low[i]!)), hi: Math.max(1, Math.round(high[i]!)) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));

  // Rank range from the refits: where each protocol's p10–p90 band would place it.
  const rankOf = (value: number): number => {
    let r = 1;
    for (const s of scored) if (s.implied > value) r++;
    return r;
  };
  const rows: Row[] = scored.map((s, i) => {
    const age = ageInDays(snap.asOf, s.p.listedAt);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl: s.p.tvl,
      growth7d: s.p.growth7d,
      listedAt: s.p.listedAt,
      ageDays: age,
      implied: s.implied,
      valueLow: s.lo,
      valueHigh: s.hi,
      rankLow: rankOf(s.hi),
      rankHigh: rankOf(s.lo),
      tvlMultiple: Math.round((s.implied / Math.max(1, s.p.tvl)) * 100) / 100,
      steps: farmPlan(s.p, age),
    };
  });

  const anchors: Anchor[] = traded
    .map((p) => {
      const fitted = Math.max(1, Math.round(Math.exp(predictOne(fit.weights, featureRow(p, snap.asOf, medianAge, cats)))));
      return {
        slug: p.slug,
        name: p.name,
        category: p.category,
        tvl: p.tvl,
        mcap: p.mcap!,
        fitted,
        multiple: Math.round((p.mcap! / Math.max(1, p.tvl)) * 100) / 100,
      };
    })
    .sort((a, b) => b.mcap - a.mcap);

  return {
    asOf: snap.asOf,
    floor: snap.floor,
    model: {
      version: MODEL_VERSION,
      features: [...FEATURE_NAMES, ...cats.map((c) => `is_${c}`)],
      weights: fit.weights.map((w) => Math.round(w * 10000) / 10000),
      rSquared: Math.round(fit.rSquared * 10000) / 10000,
      trainedOn: traded.length,
      looMedianErr: Math.round(validation.medianAbsPctErr * 10000) / 10000,
      looWithin2x: Math.round(validation.within2x * 10000) / 10000,
      looWithin15pct: Math.round(validation.within15pct * 10000) / 10000,
      refits: REFITS,
      refitsKept: kept,
      ridge: RIDGE,
      categories: cats,
    },
    watch: snap.watch,
    watchCount: snap.watch.length,
    boardCount: rows.length,
    preTokenCount: snap.protos.filter(isPreToken).length,
    tradedCount: traded.length,
    universeCount: snap.protos.length,
    rows,
    anchors,
  };
}

// ------------------------------------------------------------------ farm plans

/** The first chain a protocol lists, or a neutral fallback. */
function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its home chain';
}

/** The deposit one farm position needs, sized by the protocol's own TVL. */
function depositFor(p: Proto): number {
  if (p.tvl >= 5_000_000_000) return 500;
  if (p.tvl >= 1_000_000_000) return 300;
  if (p.tvl >= 100_000_000) return 150;
  if (p.tvl >= 25_000_000) return 100;
  return 50;
}

/** Gas for one action on a chain, in whole dollars, by chain family. */
function gasFor(chain: string): number {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return 12;
  if (c.includes('bitcoin') || c.includes('solana')) return 2;
  if (c.includes('base') || c.includes('arbitrum') || c.includes('optimism') || c.includes('polygon') || c.includes('blast') || c.includes('scroll') || c.includes('linea') || c.includes('zksync') || c.includes('mantle') || c.includes('mode')) return 1;
  return 3;
}

/** How long to hold, from the protocol's age: younger ones get a longer window. */
function holdFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category's main on-chain action, written so a farmer can follow it. */
function mainAction(p: Proto, deposit: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) {
    return `Supply $${deposit} of USDC as a lender on ${name} (${chain}) and leave the deposit earning for the whole hold.`;
  }
  if (c.includes('dex')) {
    return `Add $${deposit} of liquidity to the deepest ${name} pool on ${chain} and keep the LP tokens in your own wallet.`;
  }
  if (c.includes('leveraged farm') || c.includes('yield')) {
    return `Deposit $${deposit} into ${name}'s highest-yield vault on ${chain} and leave the vault shares untouched.`;
  }
  if (c.includes('bridge') || c.includes('canonical bridge')) {
    return `Bridge $${deposit} of USDC onto ${chain} through ${name}, then put the bridged funds to work inside its app.`;
  }
  if (c.includes('liquid staking') || c.includes('restak') || c.includes('liquid restaking')) {
    return `Stake $${deposit} through ${name} on ${chain} and hold the receipt token instead of selling it.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Post $${deposit} of USDC as collateral on ${name} (${chain}) and open one small hedged trade.`;
  }
  if (c.includes('prediction')) {
    return `Fund your ${name} account with $${deposit} on ${chain} and take one position in a live market.`;
  }
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('vault') || c.includes('onchain capital')) {
    return `Deposit $${deposit} into a ${name} vault on ${chain} and hold the vault shares for the full period.`;
  }
  if (c.includes('stable')) {
    return `Mint $${deposit} of the stable asset through ${name} on ${chain} and keep it in place.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${deposit} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${deposit} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('farm') || c.includes('algo-stable') || c.includes('options')) {
    return `Put $${deposit} of USDC to work in ${name}'s main farm on ${chain} and leave the position open.`;
  }
  return `Put $${deposit} of USDC to work inside ${name} on ${chain} and leave the position open for the hold.`;
}

/**
 * One protocol's farm plan: six steps, each with its cost and its time, built
 * from the protocol's own record (category, chains, TVL, age) — never from a
 * hand-written list of names. Every step is 20–600 characters.
 */
export function farmPlan(p: Proto, age: number | null): string[] {
  const chain = firstChain(p);
  const deposit = depositFor(p);
  const hold = holdFor(age);
  const gas = gasFor(chain);
  const second = p.chains.length > 1 ? p.chains[1]! : null;
  const weekly = Math.max(1, Math.round(deposit / 20));
  const steps: string[] = [
    `Open a fresh wallet that holds only farm funds, and write its seed phrase on paper offline — never in a screenshot, a chat or a cloud note. Cost: $0. Time: 5 minutes.`,
    `${mainAction(p, deposit, chain)} Cost: $${deposit} of capital plus about $${gas} of gas. Time: 15 minutes to set up.`,
    second === null
      ? `Top the position up by $${weekly} once a week so the wallet shows steady repeated use instead of one deposit. Cost: $${weekly} a week plus about $2 of gas. Time: 10 minutes a week.`
      : `Do the same action once on ${second} too, so the wallet is active on two of ${p.name}'s chains instead of one. Cost: about $${gasFor(second)} of gas. Time: 10 minutes.`,
    `Hold the position for at least ${hold} days so the activity spans more than one snapshot window and reads as a real user, not a one-day visitor. Cost: the $${deposit} stays in the position. Time: ${hold} days.`,
    `Once a month, open ${p.name}'s own points or rewards page from its official site and check that your wallet's activity is counted. Cost: $0 to check. Time: 10 minutes.`,
    `If a token ever appears, claim only from the link ${p.name} itself publishes, and never pay anyone to claim for you — a claim that asks for a fee or a seed phrase is a scam. Cost: gas only, and only when you claim. Time: 10 minutes.`,
  ];
  return steps.map((s) => {
    const t = s.trim();
    return t.length > 600 ? `${t.slice(0, 596)}...` : t;
  });
}

/** The dashboard's whole dataset as one script tag payload: no fetch, no network. */
export function dataScript(data: BoardData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}

/** Why a board is not one the gate will take, or null when it is fine. */
export function boardProblem(rows: Row[], snap: Snap): string | null {
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = snap.watch.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied > rows[i - 1]!.implied) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (rows.length >= 2 && rows[0]!.implied === rows[rows.length - 1]!.implied) {
    return `all ${rows.length} rows share implied value $${rows[0]!.implied}: not a ranking`;
  }
  for (const r of rows) {
    if (r.steps.length < 3 || r.steps.length > 12) return `${r.slug} has ${r.steps.length} farm steps`;
    for (const s of r.steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied) || r.implied <= 0) return `${r.slug} has implied value ${r.implied}`;
    if (r.valueLow > r.implied || r.implied > r.valueHigh) return `${r.slug} value range does not contain its implied value`;
  }
  return null;
}
