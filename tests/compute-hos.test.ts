import { describe, it, expect } from "vitest";
import { computeHos } from "../src/compute-hos.js";
import {
  DutyEvent,
  DutyStatus,
  EventSource,
  ComputeHosInput,
  HosConfig,
  RecapDay,
} from "../src/types.js";
import {
  DRIVING_LIMIT_MS,
  DUTY_WINDOW_MS,
  BREAK_REQUIRED_AFTER_MS,
  BREAK_MINIMUM_MS,
  RESET_MINIMUM_MS,
  CYCLE_60_7_MS,
  CYCLE_70_8_MS,
} from "../src/constants.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const h = (hours: number) => hours * 3_600_000;
const m = (minutes: number) => minutes * 60_000;
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

function mkOpenEvent(
  id: string,
  status: DutyStatus,
  startHours: number,
  source: EventSource = "driver",
): DutyEvent {
  return {
    id,
    driverId: "driver-1",
    status,
    startedAt: BASE + h(startHours),
    source,
  };
}

const DEFAULT_CONFIG: HosConfig = {
  cycleRule: "60_7",
  reminderLeadSeconds: 1800, // 30 minutes
};

function run(
  events: DutyEvent[],
  asOfHours: number,
  config?: Partial<HosConfig>,
  recapDays?: RecapDay[],
) {
  const input: ComputeHosInput = {
    events,
    config: { ...DEFAULT_CONFIG, ...config },
    asOf: BASE + h(asOfHours),
    recapDays,
  };
  return computeHos(input);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("computeHos", () => {
  // 1. Fresh driver (no events)
  it("returns full clocks and off_duty for no events", () => {
    const result = run([], 0);
    expect(result.snapshot.currentStatus).toBe("off_duty");
    expect(result.snapshot.drivingRemainingMs).toBe(DRIVING_LIMIT_MS);
    expect(result.snapshot.dutyWindowRemainingMs).toBe(DUTY_WINDOW_MS);
    expect(result.snapshot.breakRequiredInMs).toBeNull();
    expect(result.snapshot.cycleRemainingMs).toBe(CYCLE_60_7_MS);
    expect(result.snapshot.shiftStartedAt).toBeNull();
    expect(result.snapshot.drivingAccumulatedMs).toBe(0);
    expect(result.snapshot.onDutyAccumulatedMs).toBe(0);
    expect(result.violations).toHaveLength(0);
    expect(result.alerts).toHaveLength(0);
  });

  // 2. 5h driving => 6h remaining, break in 3h
  it("calculates remaining clocks after 5h driving", () => {
    const events = [mkEvent("1", "driving", 0, 5)];
    const result = run(events, 5);

    expect(result.snapshot.drivingRemainingMs).toBe(h(6));
    expect(result.snapshot.drivingAccumulatedMs).toBe(h(5));
    expect(result.snapshot.breakRequiredInMs).toBe(h(3));
    expect(result.snapshot.dutyWindowRemainingMs).toBe(h(9));
    expect(result.violations).toHaveLength(0);
  });

  // 3. 11h driving => driving_11h violation
  it("fires driving_11h violation at 11h+", () => {
    const events = [mkEvent("1", "driving", 0, 12)];
    const result = run(events, 12);

    expect(result.snapshot.drivingRemainingMs).toBe(0);
    expect(result.snapshot.drivingAccumulatedMs).toBe(h(12));
    const v = result.violations.find((v) => v.rule === "driving_11h");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("violation");
  });

  // 4. 8h driving no break => break_30min violation
  it("fires break_30min violation after 8h driving without break", () => {
    const events = [mkEvent("1", "driving", 0, 9)];
    const result = run(events, 9);

    const v = result.violations.find((v) => v.rule === "break_30min");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("violation");
    expect(result.snapshot.breakRequiredInMs).toBe(0);
  });

  // 5. 7.5h driving + 30min off => break timer reset, no violation
  it("resets break timer after 30min off-duty", () => {
    const events = [
      mkEvent("1", "driving", 0, 7.5),
      mkEvent("2", "off_duty", 7.5, 8),
      mkEvent("3", "driving", 8, 9),
    ];
    const result = run(events, 9);

    // After break reset, only 1h driving since break
    expect(result.snapshot.breakRequiredInMs).toBe(h(7)); // 8h - 1h = 7h
    const v = result.violations.find((v) => v.rule === "break_30min");
    expect(v).toBeUndefined();
  });

  // 6. 10h off-duty => full shift reset
  it("resets shift after 10h off-duty", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "off_duty", 5, 15), // 10h off
      mkEvent("3", "driving", 15, 17),
    ];
    const result = run(events, 17);

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(2));
    expect(result.snapshot.onDutyAccumulatedMs).toBe(h(2));
    expect(result.snapshot.shiftStartedAt).toBe(BASE + h(15));
    expect(result.snapshot.drivingRemainingMs).toBe(h(9));
    expect(result.snapshot.lastResetAt).toBe(BASE + h(15));
  });

  // 7. 14h window exhausted => duty_window_14h violation
  it("fires duty_window_14h violation when window expires", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "on_duty_not_driving", 5, 10),
      mkEvent("3", "off_duty", 10, 12), // 2h off (not a qualifying reset)
      mkEvent("4", "driving", 12, 15),
    ];
    const result = run(events, 15);

    // Shift started at h(0), 15h elapsed > 14h window
    const v = result.violations.find((v) => v.rule === "duty_window_14h");
    expect(v).toBeDefined();
    expect(v!.severity).toBe("violation");
    expect(result.snapshot.dutyWindowRemainingMs).toBe(0);
  });

  // 8. 34h off-duty (cycle restart handled by recap — here we just verify reset)
  it("resets shift fully after 34h off-duty", () => {
    const events = [
      mkEvent("1", "driving", 0, 10),
      mkEvent("2", "off_duty", 10, 44), // 34h off
      mkEvent("3", "driving", 44, 46),
    ];
    const result = run(events, 46);

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(2));
    expect(result.snapshot.shiftStartedAt).toBe(BASE + h(44));
    expect(result.snapshot.lastResetAt).toBe(BASE + h(44));
  });

  // 9. Multi-day cycle near limit — approaching warning
  it("fires cycle_limit approaching alert when near cycle limit", () => {
    // RecapDays: 6 previous days, each with 9h on-duty (54h total)
    // Current day: 5.5h driving = 59.5h total out of 60h
    const recapDays: RecapDay[] = [];
    for (let d = 1; d <= 6; d++) {
      recapDays.push({
        date: `2025-01-0${d}`,
        onDutySeconds: 0,
        drivingSeconds: 9 * 3600,
        offDutySeconds: 15 * 3600,
        sleeperSeconds: 0,
      });
    }

    // Day 7 starts at hour 144 (6 days)
    const dayStart = 144;
    const events = [mkEvent("1", "driving", dayStart, dayStart + 5.5)];
    const result = run(
      events,
      dayStart + 5.5,
      { reminderLeadSeconds: 1800 },
      recapDays,
    );

    // Cycle remaining = 60h - 54h(recap) - 5.5h(today) = 0.5h = 30min
    expect(result.snapshot.cycleRemainingMs).toBe(h(0.5));
    const alert = result.alerts.find((a) => a.rule === "cycle_limit");
    expect(alert).toBeDefined();
    expect(alert!.type).toBe("approaching_limit");
  });

  it("does not double count the current day between recap rows and live segments", () => {
    const recapDays: RecapDay[] = [];
    for (let d = 1; d <= 6; d++) {
      recapDays.push({
        date: `2025-01-0${d}`,
        onDutySeconds: 0,
        drivingSeconds: 8 * 3600,
        offDutySeconds: 16 * 3600,
        sleeperSeconds: 0,
      });
    }
    recapDays.push({
      date: "2025-01-07",
      onDutySeconds: 0,
      drivingSeconds: 6 * 3600,
      offDutySeconds: 18 * 3600,
      sleeperSeconds: 0,
    });

    const dayStart = 144;
    const events = [mkEvent("1", "driving", dayStart, dayStart + 6)];
    const result = run(events, dayStart + 6, undefined, recapDays);

    expect(result.snapshot.cycleRemainingMs).toBe(h(6));
  });

  // 10. Mixed on-duty and driving
  it("tracks both on_duty_not_driving and driving in accumulators", () => {
    const events = [
      mkEvent("1", "on_duty_not_driving", 0, 2),
      mkEvent("2", "driving", 2, 6),
      mkEvent("3", "on_duty_not_driving", 6, 8),
    ];
    const result = run(events, 8);

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(4));
    expect(result.snapshot.onDutyAccumulatedMs).toBe(h(8)); // 2 + 4 + 2
    expect(result.snapshot.dutyWindowRemainingMs).toBe(h(6)); // 14 - 8
    expect(result.snapshot.currentStatus).toBe("on_duty_not_driving");
  });

  // 11. Multiple short breaks (none qualifying as 30min)
  it("does not reset break timer with short breaks under 30min", () => {
    const events = [
      mkEvent("1", "driving", 0, 3),
      mkEvent("2", "off_duty", 3, 3.4), // 24 min — not qualifying
      mkEvent("3", "driving", 3.4, 6.4),
      mkEvent("4", "off_duty", 6.4, 6.7), // 18 min — not qualifying
      mkEvent("5", "driving", 6.7, 9),
    ];
    const result = run(events, 9);

    // Total driving = 3 + 3 + 2.3 = 8.3h, no qualifying break
    // breakRequiredInMs should be 0 (violated)
    expect(result.snapshot.breakRequiredInMs).toBe(0);
    const v = result.violations.find((v) => v.rule === "break_30min");
    expect(v).toBeDefined();
  });

  // 12. Exactly at 11h driving limit (boundary)
  it("does not fire violation at exactly 11h driving", () => {
    const events = [mkEvent("1", "driving", 0, 11)];
    const result = run(events, 11);

    expect(result.snapshot.drivingRemainingMs).toBe(0);
    expect(result.snapshot.drivingAccumulatedMs).toBe(h(11));
    // At exactly the limit, not over — no violation
    const v = result.violations.find((v) => v.rule === "driving_11h");
    expect(v).toBeUndefined();
  });

  // 13. Exactly at 14h window (boundary)
  it("does not fire violation at exactly 14h window", () => {
    const events = [
      mkEvent("1", "driving", 0, 8),
      mkEvent("2", "off_duty", 8, 8.5), // qualifying break
      mkEvent("3", "on_duty_not_driving", 8.5, 14),
    ];
    const result = run(events, 14);

    // Window = 14h - 0h = 14h elapsed, exactly at limit
    expect(result.snapshot.dutyWindowRemainingMs).toBe(0);
    const v = result.violations.find((v) => v.rule === "duty_window_14h");
    expect(v).toBeUndefined();
  });

  // 14. Exactly at 8h driving before break (boundary)
  it("does not fire break violation at exactly 8h driving", () => {
    const events = [mkEvent("1", "driving", 0, 8)];
    const result = run(events, 8);

    expect(result.snapshot.breakRequiredInMs).toBe(0);
    // At exactly 8h, the break is needed before any more driving. The limit has
    // not been exceeded at the boundary itself.
    const v = result.violations.find((v) => v.rule === "break_30min");
    expect(v).toBeUndefined();
  });

  // 15. 70/8 cycle rule
  it("uses 70/8 cycle limit when configured", () => {
    const events = [mkEvent("1", "driving", 0, 5)];
    const result = run(events, 5, { cycleRule: "70_8" });

    // cycleRemaining = 70h - 5h = 65h (no recap days)
    expect(result.snapshot.cycleRemainingMs).toBe(h(65));
  });

  // 16. Driving alert approaching
  it("fires driving approaching alert within lead time", () => {
    const events = [mkEvent("1", "driving", 0, 10.75)]; // 10h45m driving, 15min left
    const result = run(events, 10.75, { reminderLeadSeconds: 1800 });

    const alert = result.alerts.find((a) => a.rule === "driving_11h");
    expect(alert).toBeDefined();
    expect(alert!.remainingMs).toBe(m(15));
  });

  // 17. No driving alert when well within limits
  it("does not fire alerts when well within limits", () => {
    const events = [mkEvent("1", "driving", 0, 3)];
    const result = run(events, 3, { reminderLeadSeconds: 1800 });

    expect(result.alerts).toHaveLength(0);
  });

  // 18. Recap output for single day
  it("derives correct recap for a single day", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "off_duty", 5, 8),
      mkEvent("3", "on_duty_not_driving", 8, 10),
    ];
    const result = run(events, 10);

    const day = result.recap.find((r) => r.date === "2025-01-01");
    expect(day).toBeDefined();
    expect(day!.drivingSeconds).toBe(5 * 3600);
    expect(day!.offDutySeconds).toBe(3 * 3600);
    expect(day!.onDutySeconds).toBe(2 * 3600);
  });

  // 19. hosVersion is always v1
  it("always returns hosVersion v1", () => {
    const result = run([], 0);
    expect(result.snapshot.hosVersion).toBe("v1");
  });

  // 20. Sleeper berth counts toward off-duty for reset
  it("counts sleeper_berth as off-duty for 10h reset", () => {
    const events = [
      mkEvent("1", "driving", 0, 5),
      mkEvent("2", "sleeper_berth", 5, 15), // 10h sleeper
      mkEvent("3", "driving", 15, 17),
    ];
    const result = run(events, 17);

    expect(result.snapshot.drivingAccumulatedMs).toBe(h(2));
    expect(result.snapshot.shiftStartedAt).toBe(BASE + h(15));
    expect(result.snapshot.lastResetAt).toBe(BASE + h(15));
  });

  // 21. Duty window alert approaching
  it("fires duty window approaching alert", () => {
    const events = [
      mkEvent("1", "driving", 0, 8),
      mkEvent("2", "off_duty", 8, 8.5),
      mkEvent("3", "on_duty_not_driving", 8.5, 13.75), // window = 13h45m, 15min left
    ];
    const result = run(events, 13.75, { reminderLeadSeconds: 1800 });

    const alert = result.alerts.find((a) => a.rule === "duty_window_14h");
    expect(alert).toBeDefined();
    expect(alert!.remainingMs).toBe(m(15));
  });

  // 22. Cycle violation when exceeded
  it("fires cycle_limit violation when cycle hours exceeded", () => {
    const recapDays: RecapDay[] = [];
    for (let d = 1; d <= 6; d++) {
      recapDays.push({
        date: `2025-01-0${d}`,
        onDutySeconds: 0,
        drivingSeconds: 10 * 3600,
        offDutySeconds: 14 * 3600,
        sleeperSeconds: 0,
      });
    }
    // 60h in recap, + any more driving = over
    const dayStart = 144;
    const events = [mkEvent("1", "driving", dayStart, dayStart + 1)];
    const result = run(events, dayStart + 1, { cycleRule: "60_7" }, recapDays);

    expect(result.snapshot.cycleRemainingMs).toBe(0);
    const v = result.violations.find((v) => v.rule === "cycle_limit");
    expect(v).toBeDefined();
  });

  // 23. Break alert approaching
  it("fires break approaching alert when close to 8h driving", () => {
    const events = [mkEvent("1", "driving", 0, 7.75)]; // 7h45m, 15min until break required
    const result = run(events, 7.75, { reminderLeadSeconds: 1800 });

    const alert = result.alerts.find((a) => a.rule === "break_30min");
    expect(alert).toBeDefined();
    expect(alert!.remainingMs).toBe(m(15));
  });

  // 24. On-duty not driving does NOT count toward driving limit
  it("does not count on_duty_not_driving toward driving limit", () => {
    const events = [mkEvent("1", "on_duty_not_driving", 0, 12)];
    const result = run(events, 12);

    expect(result.snapshot.drivingAccumulatedMs).toBe(0);
    // The standalone 11-hour clock is full, but displayed drive time is
    // cross-clamped to the two hours left in the active 14-hour window.
    expect(result.snapshot.drivingRemainingMs).toBe(h(2));
    // No driving violation
    const v = result.violations.find((v) => v.rule === "driving_11h");
    expect(v).toBeUndefined();
  });

  // 25. On-duty not driving DOES count toward duty window
  it("counts on_duty_not_driving toward 14h duty window", () => {
    const events = [mkEvent("1", "on_duty_not_driving", 0, 15)];
    const result = run(events, 15);

    expect(result.snapshot.dutyWindowRemainingMs).toBe(0);
    const v = result.violations.find((v) => v.rule === "duty_window_14h");
    expect(v).toBeDefined();
  });
});
