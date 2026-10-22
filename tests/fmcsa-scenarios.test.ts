import { describe, expect, it } from "vitest";
import { computeHos } from "../src/compute-hos.js";
import { normalizeEvents } from "../src/normalize-events.js";
import {
  BASE_CONFIG,
  FMCSA_BASE,
  HOUR_MS,
  PRE_RESTART_RECAP,
  SCENARIOS,
  event,
} from "./fixtures/fmcsa-property-carrying.js";

function run(
  events: readonly Parameters<typeof computeHos>[0]["events"][number][],
  asOfHour: number,
  config: Partial<Parameters<typeof computeHos>[0]["config"]> = {},
  recapDays: Parameters<typeof computeHos>[0]["recapDays"] = [],
) {
  return computeHos({
    events: [...events],
    asOf: FMCSA_BASE + asOfHour * HOUR_MS,
    config: { ...BASE_CONFIG, ...config },
    recapDays,
  });
}

describe("FMCSA property-carrying scenario fixtures", () => {
  it("accepts 30 consecutive minutes of on-duty-not-driving as the driving break", () => {
    const result = run(SCENARIOS.onDutyBreak, 9.5);

    expect(result.snapshot.breakRequiredInMs).toBe(7 * HOUR_MS);
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "break_30min",
    );
  });

  it("accepts a consecutive 30-minute break made from mixed non-driving statuses", () => {
    const result = run(
      [
        event("mixed-drive-1", "driving", 0, 8),
        event("mixed-on-duty", "on_duty_not_driving", 8, 8.25),
        event("mixed-sleeper", "sleeper_berth", 8.25, 8.5),
        event("mixed-drive-2", "driving", 8.5, 9),
      ],
      9,
    );

    expect(result.snapshot.breakRequiredInMs).toBe(7.5 * HOUR_MS);
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "break_30min",
    );
  });

  it("does not report a break violation at exactly eight cumulative driving hours", () => {
    const result = run([event("boundary", "driving", 0, 8)], 8);

    expect(result.snapshot.breakRequiredInMs).toBe(0);
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "break_30min",
    );
  });

  it("restarts the 60/7 cycle after 34 consecutive off-duty hours", () => {
    const result = run(
      SCENARIOS.restart34,
      35,
      {},
      PRE_RESTART_RECAP,
    );

    expect(result.snapshot.cycleRemainingMs).toBe(59 * HOUR_MS);
  });

  it("recalculates the clocks using a completed 8/2 sleeper pairing", () => {
    const result = run(SCENARIOS.splitEightTwo, 22, {
      sleeperBerthSplit: { enabled: true },
    });

    expect(result.snapshot.drivingAccumulatedMs).toBe(6 * HOUR_MS);
    expect(result.snapshot.drivingRemainingMs).toBe(5 * HOUR_MS);
    expect(result.snapshot.dutyWindowRemainingMs).toBe(8 * HOUR_MS);
    expect(result.violations).toHaveLength(0);
  });

  it("recalculates the clocks using a completed 7/3 sleeper pairing", () => {
    const result = run(SCENARIOS.splitSevenThree, 22, {
      sleeperBerthSplit: { enabled: true },
    });

    expect(result.snapshot.drivingAccumulatedMs).toBe(7 * HOUR_MS);
    expect(result.snapshot.drivingRemainingMs).toBe(4 * HOUR_MS);
    expect(result.snapshot.dutyWindowRemainingMs).toBe(7 * HOUR_MS);
    expect(result.violations).toHaveLength(0);
  });

  it("does not pair sleeper periods across a later 10-hour reset", () => {
    const result = run(
      [
        event("old-sleeper", "sleeper_berth", 0, 8),
        event("old-drive", "driving", 8, 9),
        event("full-reset", "off_duty", 9, 19),
        event("new-drive", "driving", 19, 20),
        event("new-short-rest", "off_duty", 20, 22),
      ],
      22,
    );

    expect(result.snapshot.drivingAccumulatedMs).toBe(1 * HOUR_MS);
    expect(result.snapshot.shiftStartedAt).toBe(FMCSA_BASE + 19 * HOUR_MS);
  });

  it("extends both property-carrier clocks by two hours for an asserted adverse condition", () => {
    const result = run(SCENARIOS.adverseDriving, 12.5, {
      adverseDrivingConditions: { enabled: true },
    });

    expect(result.snapshot.drivingRemainingMs).toBe(1 * HOUR_MS);
    expect(result.snapshot.dutyWindowRemainingMs).toBe(3.5 * HOUR_MS);
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "driving_11h",
    );
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "duty_window_14h",
    );
  });

  it("applies an eligibility-confirmed 16-hour short-haul window without extending driving", () => {
    const result = run(SCENARIOS.sixteenHour, 15.5, {
      sixteenHourShortHaul: {
        enabled: true,
        previousFiveDutyToursReturnedToReportingLocation: true,
        returnAndReleaseWithin16Hours: true,
        usedWithinPrevious6Days: false,
        cycleRestartSincePreviousUse: false,
      },
    });

    expect(result.snapshot.dutyWindowRemainingMs).toBe(0.5 * HOUR_MS);
    // The raw 11-hour clock has 2.5h, but the driver can only drive for the
    // remaining 30 minutes in the active window.
    expect(result.snapshot.drivingRemainingMs).toBe(0.5 * HOUR_MS);
  });

  it("exempts a qualifying 150-air-mile tour from the 30-minute break", () => {
    const result = run(SCENARIOS.shortHaulNoBreak, 9, {
      shortHaul: {
        enabled: true,
        maximumAirMilesFromReportingLocation: 149,
        returnedToReportingLocation: true,
      },
    });

    expect(result.snapshot.breakRequiredInMs).toBeNull();
    expect(result.violations.map((violation) => violation.rule)).not.toContain(
      "break_30min",
    );
  });

  it("does not apply the short-haul break exemption outside 150 air miles", () => {
    const result = run(SCENARIOS.shortHaulNoBreak, 9, {
      shortHaul: {
        enabled: true,
        maximumAirMilesFromReportingLocation: 151,
        returnedToReportingLocation: true,
      },
    });

    expect(result.violations.map((violation) => violation.rule)).toContain(
      "break_30min",
    );
  });

  it("uses the home-terminal timezone when distributing recap days", () => {
    const result = computeHos({
      events: [
        {
          ...event("tz", "on_duty_not_driving", 0, 1),
          startedAt: Date.parse("2025-01-01T05:30:00.000Z"),
          endedAt: Date.parse("2025-01-01T06:30:00.000Z"),
        },
      ],
      asOf: Date.parse("2025-01-01T06:30:00.000Z"),
      config: {
        ...BASE_CONFIG,
        homeTerminalTimezone: "America/Chicago",
      },
    });

    expect(result.recap.find((day) => day.date === "2024-12-31")?.onDutySeconds).toBe(
      30 * 60,
    );
    expect(result.recap.find((day) => day.date === "2025-01-01")?.onDutySeconds).toBe(
      30 * 60,
    );
  });

  it("uses the actual 23-hour home-terminal day across spring DST", () => {
    const result = computeHos({
      events: [
        {
          ...event("dst", "off_duty", 0, 1),
          startedAt: Date.parse("2025-03-09T05:00:00.000Z"),
          endedAt: Date.parse("2025-03-10T04:00:00.000Z"),
        },
      ],
      asOf: Date.parse("2025-03-10T04:00:00.000Z"),
      config: {
        ...BASE_CONFIG,
        homeTerminalTimezone: "America/New_York",
      },
    });

    expect(result.recap.find((day) => day.date === "2025-03-09")?.offDutySeconds).toBe(
      23 * 3_600,
    );
  });

  it("closes older open events at the next chronological status change", () => {
    const normalized = normalizeEvents([...SCENARIOS.multipleOpenEvents]);

    expect(normalized.map(({ status, startedAt, endedAt }) => ({
      status,
      startHour: (startedAt - FMCSA_BASE) / HOUR_MS,
      endHour: endedAt === undefined ? undefined : (endedAt - FMCSA_BASE) / HOUR_MS,
    }))).toEqual([
      { status: "driving", startHour: 0, endHour: 2 },
      { status: "on_duty_not_driving", startHour: 2, endHour: 3 },
      { status: "off_duty", startHour: 3, endHour: undefined },
    ]);

    const result = run(SCENARIOS.multipleOpenEvents, 4);
    expect(result.snapshot.drivingAccumulatedMs).toBe(2 * HOUR_MS);
    expect(result.snapshot.onDutyAccumulatedMs).toBe(3 * HOUR_MS);
    expect(result.snapshot.currentStatus).toBe("off_duty");
  });

  it("cross-clamps the displayed driving clock to the 14-hour window", () => {
    const result = run(
      [
        event("clamp-drive", "driving", 0, 5),
        event("clamp-on-duty", "on_duty_not_driving", 5, 13.5),
      ],
      13.5,
    );

    expect(result.snapshot.dutyWindowRemainingMs).toBe(0.5 * HOUR_MS);
    expect(result.snapshot.drivingRemainingMs).toBe(0.5 * HOUR_MS);
  });

  it("cross-clamps the displayed driving clock to the cycle clock", () => {
    const recapDays = Array.from({ length: 6 }, (_, index) => ({
      date: `2025-01-0${index + 2}`,
      onDutySeconds: 0,
      drivingSeconds: 9.5 * 3_600,
      offDutySeconds: 14.5 * 3_600,
      sleeperSeconds: 0,
    }));
    const result = run([event("cycle-clamp", "driving", 0, 2)], 2, {}, recapDays);

    expect(result.snapshot.cycleRemainingMs).toBe(1 * HOUR_MS);
    expect(result.snapshot.drivingRemainingMs).toBe(1 * HOUR_MS);
  });
});
