/**
 * @fileoverview Timing for the linear-time tests that holds on a loaded
 * machine. Samples are thread CPU time (`process.threadCpuUsage`), so time the
 * test's thread spends descheduled does not count; each size keeps its fastest
 * of seven rounds, and every round times every size in turn, so a slow round,
 * a cold JIT or a busy stretch drops out or slows all sizes alike; growth is
 * asserted as a ratio with 4x headroom over linear (quadratic is 16x over),
 * beside a generous absolute bound.
 * @module tests/fixtures/cpu-time
 */

import { expect } from 'vitest';

/** Thread CPU milliseconds a sample aims to spend, so timer resolution and call overhead weigh the same at every size. */
const SAMPLE_MS = 4;
const ROUNDS = 7;

/** Thread CPU milliseconds `run` takes. */
function cpuMs(run: () => void): number {
  const start = process.threadCpuUsage();
  run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1_000;
}

/** `run`'s result and the thread CPU milliseconds it took, awaited. */
export async function cpuTimedAsync<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = process.threadCpuUsage();
  const value = await run();
  const { user, system } = process.threadCpuUsage(start);
  return { ms: (user + system) / 1_000, value };
}

/**
 * Per-call thread CPU milliseconds of `run` on each input, the fastest of
 * seven rounds. A warm-up call per input sets how many calls a sample makes
 * (about 4 ms of CPU, at least one call); each round then times every input
 * in turn.
 */
export function perCallCpuMs<T>(run: (input: T) => unknown, inputs: readonly T[]): number[] {
  const samples = inputs.map((input) => {
    run(input);
    const ms = cpuMs(() => run(input));
    return {
      input,
      calls: Math.max(1, Math.ceil(SAMPLE_MS / Math.max(ms, 0.001))),
      best: Number.POSITIVE_INFINITY,
    };
  });
  for (let round = 0; round < ROUNDS; round++) {
    for (const sample of samples) {
      const ms = cpuMs(() => {
        for (let call = 0; call < sample.calls; call++) run(sample.input);
      });
      sample.best = Math.min(sample.best, ms / sample.calls);
    }
  }
  return samples.map((sample) => sample.best);
}

/**
 * Asserts `run(make(size))` takes time linear in `size` over three sizes
 * (default 5,000, 20,000 and 80,000, in `make`'s units): the fastest per-call
 * thread CPU time at the largest stays under four times the linear ratio
 * between the largest and smallest (64 for a 16x spread, where quadratic
 * gives 256), and under `maxMs` at every size.
 */
export function expectLinearTime<T>(
  make: (size: number) => T,
  run: (input: T) => unknown,
  {
    sizes = [5_000, 20_000, 80_000],
    maxMs,
  }: { sizes?: readonly [number, number, number]; maxMs: number },
): void {
  const [small, middle, large] = sizes;
  const [tSmall = 0, tMiddle = 0, tLarge = 0] = perCallCpuMs(run, sizes.map(make));
  expect(tLarge / tSmall, `${large} vs ${small}`).toBeLessThan((4 * large) / small);
  expect(Math.max(tSmall, tMiddle, tLarge), `${small}, ${middle}, ${large}`).toBeLessThan(maxMs);
}
