import type { DutyStatus, RecapDay } from "./types";
import {
  dateInTimeZone,
  nextDateInTimeZone,
} from "./time-zone";

export type Segment = { status: DutyStatus; start: number; end: number };

/**
 * Derive per-day recap from segments. Merges with existing recapDays
 * for days not covered by current segments.
 */
export function deriveRecap(
  segments: Segment[],
  _asOf: number,
  existingRecap: RecapDay[] = [],
  timeZone = "UTC",
): RecapDay[] {
  const dayMap = new Map<string, RecapDay>();

  // Which days the events themselves cover. For those days the events are the
  // better source, so the stored recap row is not seeded — seeding it and then
  // adding the segments on top counted every such day twice.
  const daysFromSegments = new Set<string>();
  for (const seg of segments) {
    let cursor = seg.start;
    while (cursor < seg.end) {
      const dayStr = dateInTimeZone(cursor, timeZone);
      daysFromSegments.add(dayStr);
      cursor = Math.min(seg.end, nextDateInTimeZone(dayStr, timeZone));
    }
  }

  // Seed from existing recap, for days the events do not cover.
  for (const day of existingRecap) {
    if (daysFromSegments.has(day.date)) continue;
    dayMap.set(day.date, { ...day });
  }

  // Distribute segments across home-terminal calendar days.
  for (const seg of segments) {
    let cursor = seg.start;
    while (cursor < seg.end) {
      const dayStr = dateInTimeZone(cursor, timeZone);
      const dayEnd = nextDateInTimeZone(dayStr, timeZone);
      const segEnd = Math.min(seg.end, dayEnd);
      const durationSec = (segEnd - cursor) / 1000;

      if (!dayMap.has(dayStr)) {
        dayMap.set(dayStr, {
          date: dayStr,
          onDutySeconds: 0,
          drivingSeconds: 0,
          offDutySeconds: 0,
          sleeperSeconds: 0,
        });
      }

      const day = dayMap.get(dayStr);
      if (!day) throw Error("Day Not Found"); // Should never happen
      switch (seg.status) {
        case "driving":
          day.drivingSeconds += durationSec;
          break;
        case "on_duty_not_driving":
          day.onDutySeconds += durationSec;
          break;
        case "off_duty":
          day.offDutySeconds += durationSec;
          break;
        case "sleeper_berth":
          day.sleeperSeconds += durationSec;
          break;
      }

      cursor = segEnd;
    }
  }

  return Array.from(dayMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}
