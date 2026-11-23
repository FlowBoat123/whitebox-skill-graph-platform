/**
 * Zero-dependency pure-TypeScript statistical significance & effect-size engine
 * for IEEE empirical software-engineering evaluation (Phase C).
 *
 * Implements:
 * - Wilson Score 95% Confidence Intervals for binomial proportions
 * - Two-sided Fisher's Exact Test (exact hypergeometric probabilities via log-gamma)
 * - Exact two-sided McNemar's Test for paired binary outcomes
 * - Two-sided Mann-Whitney U Test (with tie correction & normal approximation)
 * - Cliff's Delta non-parametric effect size with Romano et al. magnitude thresholds
 */

export interface WilsonInterval {
  k: number;
  n: number;
  ratePct: number;
  lowerPct: number;
  upperPct: number;
}

export interface MannWhitneyResult {
  u: number;
  z: number;
  pValue: number;
  n1: number;
  n2: number;
  median1: number;
  median2: number;
}

export type EffectMagnitude = "negligible" | "small" | "medium" | "large";

export interface CliffsDeltaResult {
  delta: number;
  magnitude: EffectMagnitude;
}

/** Lanczos approximation to ln(Gamma(x)) accurate to ~15 significant digits for x > 0. */
function logGamma(x: number): number {
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xm1 = x - 1;
  let a = p[0]!;
  for (let i = 1; i < g + 2; i++) {
    a += p[i]! / (xm1 + i);
  }
  const t = xm1 + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a);
}

function logFactorial(n: number): number {
  if (n <= 1) return 0;
  return logGamma(n + 1);
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** Standard normal CDF Phi(z) via Abramowitz & Stegun 7.1.26 erf approximation. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** Wilson Score 95% Confidence Interval for k successes out of n trials. */
export function wilsonCI95(k: number, n: number, z = 1.959963984540054): WilsonInterval {
  if (n <= 0) {
    return { k: 0, n: 0, ratePct: 0, lowerPct: 0, upperPct: 0 };
  }
  const clampedK = Math.max(0, Math.min(k, n));
  const p = clampedK / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  const lower = Math.max(0, center - half);
  const upper = Math.min(1, center + half);
  return {
    k: clampedK,
    n,
    ratePct: Number((p * 100).toFixed(2)),
    lowerPct: Number((lower * 100).toFixed(2)),
    upperPct: Number((upper * 100).toFixed(2)),
  };
}

/**
 * Exact two-sided Fisher's exact test p-value for a 2x2 contingency table:
 *   | a  b |
 *   | c  d |
 * Sums probabilities of all tables with the same marginals whose probability
 * is <= observed probability (standard R `fisher.test` definition).
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total <= 0) return 1;

  const hyperProb = (x: number): number =>
    Math.exp(logChoose(row1, x) + logChoose(row2, col1 - x) - logChoose(total, col1));

  const pObs = hyperProb(a);
  const minX = Math.max(0, col1 - row2);
  const maxX = Math.min(row1, col1);

  let pSum = 0;
  for (let x = minX; x <= maxX; x++) {
    const px = hyperProb(x);
    if (px <= pObs + 1e-12) {
      pSum += px;
    }
  }
  return Math.min(1, Number(pSum.toFixed(8)));
}

/**
 * Exact two-sided binomial McNemar's test p-value for paired binary outcomes.
 * - b: items where System A succeeded and System B failed
 * - c: items where System A failed and System B succeeded
 */
export function mcnemarExactTwoSided(b: number, c: number): number {
  const n = b + c;
  if (n <= 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  const logHalfN = n * Math.log(0.5);
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logChoose(n, i) + logHalfN);
  }
  return Math.min(1, Number((2 * tail).toFixed(8)));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Two-sided Mann-Whitney U test with exact tie correction and continuity correction. */
export function mannWhitneyU(xs: number[], ys: number[]): MannWhitneyResult {
  const n1 = xs.length;
  const n2 = ys.length;
  if (n1 === 0 || n2 === 0) {
    return { u: 0, z: 0, pValue: 1, n1, n2, median1: median(xs), median2: median(ys) };
  }

  const combined = [
    ...xs.map((v) => ({ v, group: 1 as const })),
    ...ys.map((v) => ({ v, group: 2 as const })),
  ].sort((a, b) => a.v - b.v);

  let r1 = 0;
  let tieCorrectionSum = 0;
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1]!.v === combined[i]!.v) {
      j++;
    }
    const avgRank = (i + 1 + (j + 1)) / 2;
    const t = j - i + 1;
    if (t > 1) {
      tieCorrectionSum += t * t * t - t;
    }
    for (let k = i; k <= j; k++) {
      if (combined[k]!.group === 1) r1 += avgRank;
    }
    i = j + 1;
  }

  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  const N = n1 + n2;
  const meanU = (n1 * n2) / 2;
  const variance =
    ((n1 * n2) / 12) * (N + 1 - tieCorrectionSum / Math.max(1, N * (N - 1)));
  if (variance <= 0) {
    return { u, z: 0, pValue: 1, n1, n2, median1: median(xs), median2: median(ys) };
  }
  const sd = Math.sqrt(variance);
  const diff = Math.abs(u - meanU);
  const z = (diff > 0.5 ? diff - 0.5 : diff) / sd;
  const pValue = Math.min(1, Number((2 * (1 - normalCdf(z))).toFixed(8)));
  return {
    u: Number(u.toFixed(2)),
    z: Number(z.toFixed(4)),
    pValue,
    n1,
    n2,
    median1: Number(median(xs).toFixed(2)),
    median2: Number(median(ys).toFixed(2)),
  };
}

/**
 * Cliff's Delta non-parametric effect size:
 * delta = (#(x > y) - #(x < y)) / (n1 * n2) in [-1, 1].
 * Thresholds per Romano et al. (2006): |d| < 0.147 negligible, < 0.33 small, < 0.474 medium, >= 0.474 large.
 */
export function cliffsDelta(xs: number[], ys: number[]): CliffsDeltaResult {
  if (xs.length === 0 || ys.length === 0) {
    return { delta: 0, magnitude: "negligible" };
  }
  let greater = 0;
  let less = 0;
  for (const x of xs) {
    for (const y of ys) {
      if (x > y) greater++;
      else if (x < y) less++;
    }
  }
  const delta = Number(((greater - less) / (xs.length * ys.length)).toFixed(4));
  const abs = Math.abs(delta);
  const magnitude: EffectMagnitude =
    abs < 0.147 ? "negligible" : abs < 0.33 ? "small" : abs < 0.474 ? "medium" : "large";
  return { delta, magnitude };
}

export function formatPValue(p: number): string {
  if (p < 0.001) return "< 0.001";
  if (p < 0.01) return p.toFixed(4);
  return p.toFixed(3);
}

export function formatWilsonCI(ci: WilsonInterval): string {
  return `${ci.ratePct.toFixed(1)}% [${ci.lowerPct.toFixed(1)}, ${ci.upperPct.toFixed(1)}]`;
}
