import { describe, it, expect } from "vitest";
import { computeHos } from "../src/compute-hos.js";
import {
  DutyEvent,
  DutyStatus,
  EventSource,
  ComputeHosInput,
  HosConfig,
} from "../src/types.js";
import { DRIVING_LIMIT_MS, DUTY_WINDOW_MS } from "../src/constants.js";

const h = (hours: number) => hours * 3_600_000;
const BASE = new Date("2025-01-01T00:00:00Z").getTime();

function mkEvent(
  id: string,
  status: DutyStatus,
  startHours: number,
  endHours: number,
  source: EventSource = "driver",
): DutyEvent {
  return {
    id,
    driverId: "driver-1",
    status,
    startedAt: BASE + h(startHours),
    endedAt: BASE + h(endHours),
    source,
  };
}

const DEFAULT_CONFIG: HosConfig = {
  cycleRule: "60_7",
  reminderLeadSeconds: 1800,
};

function run(events: DutyEvent[], asOfHours: number) {
  return computeHos({
    events,
    config: DEFAULT_CONFIG,
    asOf: BASE + h(asOfHours),
  });
}

describe("edge cases", () => {
  // 1. Out-of-order events produce same result as sorted
  it("handles out-of-order events", () => {
    const sorted = [
      mkEvent("1", "driving", 0, 3),
      mkEvent("2", "off_duty", 3, 5),
      mkEvent("3", "driving", 5, 8),
    ];
    const unsorted = [sorted[2], sorted[0], sorted[1]];

    const resultSorted = run(sorted, 8);
    const resultUnsorted = run(unsorted, 8);

    expect(resultUnsorted.snapshot.drivingAccumulatedMs).toBe(
      resultSorted.snapshot.drivingAccumulatedMs,
    );
    expect(resultUnsorted.snapshot.dutyWindowRemainingMs).toBe(
      resultSorted.snapshot.dutyWindowRemainingMs,
    );
    expect(resultUnsorted.violations.length).toBe(resultSorted.violations.length);
  });

  // 2. Overlapping events — later event wins
  it("handles overlapping events (later wins)", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "off_duty", 3, 6), // overlaps — truncates event 1 at h(3)
    ];
    const result = run(events, 6);

    // Event 1 truncated to 0-3h driving, event 2 is 3-6h off
    expect(result.snapshot.drivingAccumulatedMs).toBe(h(3));
    expect(result.snapshot.currentStatus).toBe("off_duty");
  });

  // 3. Edit-after-certify (editOf supersedes original)
  it("handles edit chains (editOf supersedes original)", () => {
    const events: DutyEvent[] = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "off_duty", 5, 8),
      // Edit: change event 1 from driving to on_duty_not_driving
      {
        id: "3",
        driverId: "driver-1",
        status: "on_duty_not_driving",
        startedAt: BASE + h(0),
        endedAt: BASE + h(5),
        source: "admin_edit",
        editOf: "1", // supersedes event 1
      },
    ];
    const result = run(events, 8);

    // Original driving event superseded, replaced with on_duty_not_driving
    expect(result.snapshot.drivingAccumulatedMs).toBe(0);
    expect(result.snapshot.onDutyAccumulatedMs).toBe(h(5));
  });

  // 4. Duplicate events (same time, same status)
  it("handles duplicate events gracefully", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "driving", 0, 5), // exact duplicate
    ];
    const result = run(events, 5);

    // Second event overlaps first — first gets truncated to zero, second remains
    expect(result.snapshot.drivingAccumulatedMs).toBe(h(5));
  });

  // 5. Very long off-duty gap — implicit off_duty fill
  it("fills gaps between events with implicit off_duty", () => {
    const events = [
      mkEvent("1", "driving", 0, 2),
      mkEvent("2", "driving", 50, 52), // 48h gap
    ];
    const result = run(events, 52);

    // 48h gap is > 10h so it resets the shift
    expect(result.snapshot.drivingAccumulatedMs).toBe(h(2)); // only second segment
    expect(result.snapshot.shiftStartedAt).toBe(BASE + h(50));
  });

  // 6. Event ending after asOf — truncated to asOf
  it("truncates events that end after asOf", () => {
    const events = [mkEvent("1", "driving", 0, 10)];
    const result = run(events, 5); // asOf is hour 5, event goes to hour 10

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(5));
    expect(result.snapshot.currentStatus).toBe("driving");
  });

  // 7. Single open-ended event (no endedAt) extends to asOf
  it("extends open-ended event to asOf", () => {
    const events: DutyEvent[] = [
      {
        id: "1",
        driverId: "driver-1",
        status: "driving",
        startedAt: BASE,
        source: "driver",
        // no endedAt
      },
    ];
    const result = computeHos({
      events,
      config: DEFAULT_CONFIG,
      asOf: BASE + h(6),
    });

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(6));
    expect(result.snapshot.currentStatus).toBe("driving");
  });

  // 8. Empty events array
  it("handles empty events with safe defaults", () => {
    const result = run([], 10);

    expect(result.snapshot.currentStatus).toBe("off_duty");
    expect(result.snapshot.drivingRemainingMs).toBe(DRIVING_LIMIT_MS);
    expect(result.snapshot.dutyWindowRemainingMs).toBe(DUTY_WINDOW_MS);
    expect(result.violations).toHaveLength(0);
  });

  // 9. Source priority: admin_edit wins over driver at same time
  it("admin_edit wins over driver at same startedAt", () => {
    const events: DutyEvent[] = [
      mkEvent("1", "driving", 0, 5, "driver"),
      mkEvent("2", "on_duty_not_driving", 0, 5, "admin_edit"),
    ];
    const result = run(events, 5);

    // admin_edit has higher priority, sorts first at same time
    // Then driver event overlaps and gets truncated to zero
    expect(result.snapshot.onDutyAccumulatedMs).toBe(h(5));
  });

  // 10. Mixed sleeper + off_duty for reset
  it("counts mixed sleeper_berth + off_duty toward 10h reset", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "sleeper_berth", 5, 10), // 5h sleeper
      mkEvent("3", "off_duty", 10, 15), // 5h off = 10h total
      mkEvent("4", "driving", 15, 17),
    ];
    const result = run(events, 17);

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(2));
    expect(result.snapshot.shiftStartedAt).toBe(BASE + h(15));
    expect(result.snapshot.lastResetAt).toBe(BASE + h(15));
  });
});
