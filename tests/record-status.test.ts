import { describe, expect, it } from "vitest";
import { computeHos } from "../src/compute-hos";
import { normalizeEvents } from "../src/normalize-events";
import type { DutyEvent, HosConfig } from "../src/types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 6, 0, 0);

const config: HosConfig = { cycleRule: "70_8", reminderLeadSeconds: 1800 };

function driving(
  id: string,
  startHour: number,
  endHour: number,
  extra: Partial<DutyEvent> = {},
): DutyEvent {
  return {
    id,
    driverId: "d1",
    status: "driving",
    startedAt: T0 + startHour * HOUR,
    endedAt: T0 + endHour * HOUR,
    source: "driver",
    ...extra,
  };
}

describe("Appendix A event record status", () => {
  it("treats a record with no recordStatus as active", () => {
    const events = [driving("a", 0, 4)];
    const result = computeHos({ events, config, asOf: T0 + 5 * HOUR });
    expect(result.snapshot.drivingAccumulatedMs).toBe(4 * HOUR);
  });

  it("ignores a carrier-proposed edit until the driver accepts it", () => {
    // 49 CFR 395.30(c): a proposed edit must not alter the driver's record.
    const events: DutyEvent[] = [
      driving("original", 0, 4, { recordStatus: "active" }),
      driving("proposal", 0, 1, {
        source: "admin_edit",
        editOf: "original",
        recordStatus: "inactive_change_requested",
      }),
    ];

    const result = computeHos({ events, config, asOf: T0 + 5 * HOUR });

    // Still 4 hours: the original stands and the proposal contributes nothing.
    expect(result.snapshot.drivingAccumulatedMs).toBe(4 * HOUR);
    expect(normalizeEvents(events).map((e) => e.id)).toEqual(["original"]);
  });

  it("applies the edit once the driver accepts it", () => {
    const events: DutyEvent[] = [
      driving("original", 0, 4, { recordStatus: "inactive_changed" }),
      driving("proposal", 0, 1, {
        source: "admin_edit",
        editOf: "original",
        recordStatus: "active",
      }),
    ];

    const result = computeHos({ events, config, asOf: T0 + 5 * HOUR });

    expect(result.snapshot.drivingAccumulatedMs).toBe(1 * HOUR);
    expect(normalizeEvents(events).map((e) => e.id)).toEqual(["proposal"]);
  });

  it("leaves the original intact when the driver rejects the edit", () => {
    const events: DutyEvent[] = [
      driving("original", 0, 4, { recordStatus: "active" }),
      driving("proposal", 0, 1, {
        source: "admin_edit",
        editOf: "original",
        recordStatus: "inactive_change_rejected",
      }),
    ];

    const result = computeHos({ events, config, asOf: T0 + 5 * HOUR });

    expect(result.snapshot.drivingAccumulatedMs).toBe(4 * HOUR);
    expect(normalizeEvents(events).map((e) => e.id)).toEqual(["original"]);
  });

  it("a rejected proposal never supersedes, even chained", () => {
    const events: DutyEvent[] = [
      driving("original", 0, 4, { recordStatus: "active" }),
      driving("p1", 0, 3, {
        source: "admin_edit",
        editOf: "original",
        recordStatus: "inactive_change_rejected",
      }),
      driving("p2", 0, 2, {
        source: "admin_edit",
        editOf: "original",
        recordStatus: "inactive_change_requested",
      }),
    ];

    expect(normalizeEvents(events).map((e) => e.id)).toEqual(["original"]);
    const result = computeHos({ events, config, asOf: T0 + 5 * HOUR });
    expect(result.snapshot.drivingAccumulatedMs).toBe(4 * HOUR);
  });
});
