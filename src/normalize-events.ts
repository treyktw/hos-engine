import type { DutyEvent } from "./types";
import { SOURCE_PRIORITY } from "./constants";

/**
 * A record counts toward hours-of-service only while its Appendix A record
 * status is `active`. Rows written before `recordStatus` existed have no value
 * and are treated as active.
 */
function isActiveRecord(event: DutyEvent): boolean {
  return event.recordStatus === undefined || event.recordStatus === "active";
}

/**
 * Normalize events: drop non-active records, filter out superseded edits, sort
 * chronologically, resolve overlaps (later event wins at overlap point).
 *
 * A carrier-proposed edit (`inactive_change_requested`) must not alter the
 * driver's record until the driver accepts it — 49 CFR 395.30(c). Dropping
 * non-active records first is what enforces that here: an unaccepted proposal
 * neither contributes its own time nor supersedes the event it targets.
 */
export function normalizeEvents(events: DutyEvent[]): DutyEvent[] {
  // 0. Drop records that are not active (proposed, rejected, or superseded).
  const live = events.filter(isActiveRecord);

  // 1. Build set of superseded event IDs — only active edits supersede.
  const supersededIds = new Set<string>();
  for (const e of live) {
    if (e.editOf) supersededIds.add(e.editOf);
  }

  // 2. Filter out superseded events
  const active = live.filter((e) => !supersededIds.has(e.id));

  // 3. Sort by startedAt, then by source priority. Lower-priority records are
  // placed first at a tie so the higher-priority record becomes the effective
  // event after the earlier record is truncated to zero.
  active.sort((a, b) => {
    const timeDiff = a.startedAt - b.startedAt;
    if (timeDiff !== 0) return timeDiff;
    const priorityDiff =
      (SOURCE_PRIORITY[a.source] ?? 0) - (SOURCE_PRIORITY[b.source] ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.id.localeCompare(b.id);
  });

  // 4. Resolve overlaps: if event B starts before event A ends, truncate A at B's start
  const resolved: DutyEvent[] = [];
  for (let i = 0; i < active.length; i++) {
    const current = { ...active[i] };
    const next = active[i + 1];
    if (
      next &&
      (current.endedAt === undefined || next.startedAt < current.endedAt)
    ) {
      current.endedAt = next.startedAt;
    }
    // Skip zero-duration events after truncation
    if (current.endedAt && current.endedAt <= current.startedAt) continue;
    resolved.push(current);
  }

  return resolved;
}
