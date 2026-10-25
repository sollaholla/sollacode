/** Nearest-rank percentile of a sample; null for an empty one. */
export function percentile(values: ReadonlyArray<number>, fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export interface LatencySummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export function summarize(values: ReadonlyArray<number>): LatencySummary {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
    mean:
      values.length === 0
        ? null
        : values.reduce((total, value) => total + value, 0) / values.length,
  };
}

export interface ReceivedMarker {
  readonly at: number;
  readonly marker: number | null;
}

/**
 * Change-to-visible latency of each counter change the page made: the time
 * from the page changing the marker to the first received picture showing that
 * value or a later one. A change superseded before any picture showed it is
 * "visible" once a later value is, which is what a person watching would see.
 * Changes too close to the end of the window to have been delivered are left
 * out; the rest that never showed up are counted as missed.
 */
export function markLatencies(input: {
  readonly marks: ReadonlyArray<readonly [number, number]>;
  readonly received: ReadonlyArray<ReceivedMarker>;
  readonly from: number;
  readonly until: number;
}): { readonly latencies: ReadonlyArray<number>; readonly missed: number } {
  const latencies: Array<number> = [];
  let missed = 0;
  for (const [value, changedAt] of input.marks) {
    if (changedAt < input.from || changedAt > input.until) continue;
    const shown = input.received.find(
      (frame) => frame.at >= changedAt && frame.marker !== null && frame.marker >= value,
    );
    if (shown === undefined) missed += 1;
    else latencies.push(shown.at - changedAt);
  }
  return { latencies, missed };
}
