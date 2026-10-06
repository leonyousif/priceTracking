/** Focused matcher call-pattern comparison; run with `tsx scripts/benchmark-matcher.ts`. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compileProductMatchPolicy, isProductMatch, ProductMatchOptions } from '../services/product-matcher';

const workloads: { target: ProductMatchOptions; titles: string[] }[] = [
  { target: { query: 'RTX 3080', category: 'GPU', negativeKeywords: 'custom shroud,used shell' }, titles: [
    'EVGA RTX 3080 FTW3 Ultra Graphics Card', 'EVGA RTX 3080 Ti FTW3 Ultra',
    'RTX 3080 waterblock box only', 'RTX 3080 in original box',
    'RTX 3080 RTX 3070 choose model', 'RTX 3080 custom shroud',
  ] },
  { target: { query: 'RX 6800 XT', category: 'GPU' }, titles: [
    'AMD RX 6800 XT Graphics Card', 'AMD RX 6800 Graphics Card',
    'RX 6800 XT backplate', 'RX 6800 XT in original box',
  ] },
  { target: { query: 'RTX 4080 Super', category: 'GPU' }, titles: [
    'NVIDIA RTX 4080 Super Graphics Card', 'NVIDIA RTX 4080 Graphics Card',
    'RTX 4080 Super water block', 'RTX 4080 Super Founders Edition',
  ] },
  { target: { query: 'PS5 console', category: 'Console' }, titles: [
    'Sony PS5 Slim Console with 2 Controllers', 'PS5 Console Cover no console',
    'PS5 Disc Edition Console in original box', 'PS5 Portal Remote Player',
  ] },
];

const samples = workloads.flatMap(({ target, titles }) => titles.map((title) => ({ target, title })));
const compiled = workloads.map(({ target }) => compileProductMatchPolicy(target));
const uncached = () => samples.map(({ target, title }) => isProductMatch(title, target));
const cached = () => workloads.flatMap(({ titles }, index) => titles.map(compiled[index]));
assert.deepEqual(cached(), uncached(), 'both call patterns return identical match, reason, and pattern');

const rounds = 7;
const iterations = 5000;
function measure(run: () => unknown) {
  run(); // warm-up
  const times: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    times.push(performance.now() - start);
  }
  return { timesMs: times.map((time) => Number(time.toFixed(3))), medianMs: [...times].sort((a, b) => a - b)[3] };
}
const uncachedResult = measure(uncached);
const cachedResult = measure(cached);
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  workload: { searches: workloads.length, titles: samples.length, iterations, rounds, warmup: 1 },
  equivalence: 'all match results, reasons, and patterns equal',
  perTitleCompilation: uncachedResult,
  perSearchCompilation: cachedResult,
}, null, 2));
