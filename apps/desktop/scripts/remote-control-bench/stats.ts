/** Marker timestamps use a common, clock-corrected millisecond time base. */
export type Marker = readonly [id: number, at: number];

export interface Stats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  readonly max: number;
}

export function stats(samples: ReadonlyArray<number>): Stats | null {
  if (samples.length === 0) return null;
  const sorted = samples.toSorted((a, b) => a - b);
  const round = (n: number) => Math.round(n * 10) / 10;
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    max: round(sorted.at(-1)!),
  };
}

/**
 * Each source update waits for its own or a newer displayed marker. Measuring
 * only exact matches makes a stream that drops nearly every frame look fast.
 * Superseded updates remain latency samples, and never-delivered updates are
 * counted separately rather than silently disappearing from the denominator.
 */
export function measureUpdates(input: {
  readonly changes: ReadonlyArray<Marker>;
  readonly displayed: ReadonlyArray<Marker>;
  readonly from: number;
  readonly until: number;
  readonly observedUntil: number;
}) {
  const changes = input.changes.filter(([, at]) => at >= input.from && at <= input.until);
  const displayed = input.displayed.filter(([, at]) => at <= input.observedUntil);
  const latencies: number[] = [];
  const exactLatencies: number[] = [];
  let superseded = 0;
  let missed = 0;
  for (const [id, at] of changes) {
    const shown = displayed.find(([shownId, shownAt]) => shownId >= id && shownAt >= at);
    if (!shown) {
      missed++;
      continue;
    }
    latencies.push(shown[1] - at);
    if (shown[0] === id) exactLatencies.push(shown[1] - at);
    else superseded++;
  }
  return { latencies, exactLatencies, updates: changes.length, superseded, missed };
}

/**
 * Sample outstanding-update age uniformly in time. It is zero while the
 * viewer is current (including a static page), and grows from the first source
 * change newer than its displayed marker while stale. Missing pictures are
 * reported as blackout samples, never as zero-latency observations.
 */
export function measureStaleness(input: {
  readonly changes: ReadonlyArray<Marker>;
  readonly displayed: ReadonlyArray<Marker>;
  readonly from: number;
  readonly until: number;
  readonly stepMs?: number;
}) {
  const ages: number[] = [];
  let blackoutSamples = 0;
  const stepMs = input.stepMs ?? 50;
  if (!(stepMs > 0)) throw new Error("stepMs must be positive");
  for (let at = input.from; at < input.until; at += stepMs) {
    const shown = input.displayed.findLast(([, time]) => time <= at);
    if (!shown) {
      blackoutSamples++;
      continue;
    }
    const pending = input.changes.find(([id, time]) => id > shown[0] && time <= at);
    ages.push(pending ? at - pending[1] : 0);
  }
  return { ages, blackoutSamples, sampleIntervalMs: stepMs };
}
