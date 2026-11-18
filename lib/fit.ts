// Comps-fit engine: a small OLS fitter, leave-one-out validation and bootstrap
// refits, all in plain Node 22 with no dependencies. The fitter learns the launch
// price from the protocols whose tokens already trade, then prices the ones that
// have not launched yet. Nothing here names a protocol: the same fit scores all.

/** One fitted line: the coefficients, the fit quality and the training size. */
export interface Fit {
  weights: number[];
  rSquared: number;
  n: number;
  residualSd: number;
}

/** A single out-of-sample check: what the model said vs what the market said. */
export interface Holdout {
  slug: string;
  actual: number;
  predicted: number;
  absPctErr: number;
}

/** The validation summary the dashboard prints. */
export interface Validation {
  medianAbsPctErr: number;
  within2x: number;
  within15pct: number;
  holdouts: Holdout[];
}

/** Solve A x = b by Gaussian elimination with partial pivoting. A is n x n. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] | null {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / a[col]![col]!;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r]![c]! * x[c]!;
    x[r] = s / a[r]![r]!;
  }
  return x;
}

/** Ordinary least squares: y ~ X. `ridge` adds a penalty to the slopes (not the
 * intercept) so near-collinear columns stay stable. Returns null when singular. */
export function ols(features: number[][], target: number[], ridge = 0): Fit | null {
  const n = target.length;
  const k = features[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const row = features[i]!;
    for (let j = 0; j < k; j++) {
      xty[j]! += row[j]! * target[i]!;
      for (let m = 0; m < k; m++) xtx[j]![m]! += row[j]! * row[m]!;
    }
  }
  for (let j = 1; j < k; j++) xtx[j]![j]! += ridge;
  const weights = solveLinear(xtx, xty);
  if (weights === null) return null;
  let ssRes = 0;
  let ssTot = 0;
  const mean = target.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < k; j++) pred += weights[j]! * features[i]![j]!;
    ssRes += (target[i]! - pred) ** 2;
    ssTot += (target[i]! - mean) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const residualSd = n > k ? Math.sqrt(ssRes / (n - k)) : 0;
  return { weights, rSquared, n, residualSd };
}

/** Dot product of a weight vector and one feature row. */
export function predictOne(weights: number[], row: number[]): number {
  let s = 0;
  for (let j = 0; j < weights.length; j++) s += weights[j]! * row[j]!;
  return s;
}

/** Leave-one-out: refit without each row, predict the held-out one, score the miss. */
export function leaveOneOut(features: number[][], target: number[], slugs: string[], ridge = 0): Validation {
  const holdouts: Holdout[] = [];
  for (let i = 0; i < target.length; i++) {
    const subF = features.filter((_, j) => j !== i);
    const subY = target.filter((_, j) => j !== i);
    const fit = ols(subF, subY, ridge);
    if (fit === null) continue;
    const pred = Math.exp(predictOne(fit.weights, features[i]!));
    const actual = Math.exp(target[i]!);
    const absPctErr = Math.abs(pred - actual) / actual;
    holdouts.push({ slug: slugs[i]!, actual, predicted: pred, absPctErr });
  }
  const errs = holdouts.map((h) => h.absPctErr).sort((a, b) => a - b);
  const mid = Math.floor(errs.length / 2);
  const medianAbsPctErr =
    errs.length % 2 === 1 ? errs[mid]! : (errs[mid - 1]! + errs[mid]!) / 2;
  const within2x = holdouts.filter((h) => h.absPctErr <= 1).length / Math.max(1, holdouts.length);
  const within15pct =
    holdouts.filter((h) => h.absPctErr <= 0.15).length / Math.max(1, holdouts.length);
  return { medianAbsPctErr, within2x, within15pct, holdouts };
}

/** A deterministic seeded PRNG (mulberry32) so refits are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap refits: resample the training rows with replacement, refit, and
 * predict every target row. Returns, per target row, the 10th and 90th percentile
 * of the refitted predictions — the value range the board prints.
 */
export function bootstrapRanges(
  features: number[][],
  target: number[],
  predictRows: number[][],
  refits: number,
  seed: number,
  ridge = 0,
): { low: number[]; high: number[]; kept: number } {
  const draw = rng(seed);
  const n = target.length;
  const collected: number[][] = predictRows.map(() => []);
  let kept = 0;
  for (let r = 0; r < refits; r++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(Math.floor(draw() * n));
    const subF = idx.map((i) => features[i]!);
    const subY = idx.map((i) => target[i]!);
    const fit = ols(subF, subY, ridge);
    if (fit === null) continue;
    kept++;
    for (let t = 0; t < predictRows.length; t++) {
      collected[t]!.push(Math.exp(predictOne(fit.weights, predictRows[t]!)));
    }
  }
  const pct = (sorted: number[], q: number): number => {
    if (sorted.length === 0) return NaN;
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  };
  const low = collected.map((c) => pct([...c].sort((a, b) => a - b), 0.1));
  const high = collected.map((c) => pct([...c].sort((a, b) => a - b), 0.9));
  return { low, high, kept };
}
