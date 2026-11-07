// Interval arithmetic for timers: every duration is "time inside these
// intervals, minus time inside the excluded ones (pauses, skips, closures)".
import type { EpochMs, TimeInterval } from "./types";

type ClosedSpan = [start: EpochMs, end: EpochMs];

/** Clips each interval at `until` (open ends run to `until`), drops empty ones, sorts and merges. */
function mergeSpans(
  intervals: readonly TimeInterval[],
  until: EpochMs,
): ClosedSpan[] {
  const spans: ClosedSpan[] = [];
  for (const interval of intervals) {
    const end = Math.min(interval.to ?? until, until);
    if (end > interval.from) spans.push([interval.from, end]);
  }
  spans.sort((left, right) => left[0] - right[0]);
  const merged: ClosedSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function overlapMs(
  start: EpochMs,
  end: EpochMs,
  mergedExcluded: readonly ClosedSpan[],
): number {
  let overlap = 0;
  for (const [excludedStart, excludedEnd] of mergedExcluded) {
    if (excludedStart >= end) break;
    overlap += Math.max(
      0,
      Math.min(end, excludedEnd) - Math.max(start, excludedStart),
    );
  }
  return overlap;
}

/**
 * Milliseconds covered by `intervals` up to `until`, excluding any time inside
 * `excluded`. `intervals` must not overlap each other; `excluded` may.
 */
export function measureMs(
  intervals: readonly TimeInterval[],
  until: EpochMs,
  excluded: readonly TimeInterval[] = [],
): number {
  const mergedExcluded = mergeSpans(excluded, until);
  let total = 0;
  for (const interval of intervals) {
    const end = Math.min(interval.to ?? until, until);
    if (end <= interval.from) continue;
    total +=
      end - interval.from - overlapMs(interval.from, end, mergedExcluded);
  }
  return total;
}

/** The parts of `intervals` at or after `start`. */
export function intervalsFrom(
  intervals: readonly TimeInterval[],
  start: EpochMs,
): TimeInterval[] {
  const clipped: TimeInterval[] = [];
  for (const interval of intervals) {
    if (interval.to !== null && interval.to <= start) continue;
    clipped.push({ from: Math.max(interval.from, start), to: interval.to });
  }
  return clipped;
}
