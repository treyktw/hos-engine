import { describe, expect, it } from "vitest";
import { computeHos } from "../src/compute-hos";
import { deriveRecap } from "../src/derive-recap";
import {
  addCalendarDays,
  dateInTimeZone,
  isValidTimeZone,
  startOfDateInTimeZone,
} from "../src/time-zone";
import type { DutyEvent, HosConfig, RecapDay } from "../src/types";

const HOUR = 3_600_000;

describe("home-terminal day boundaries", () => {
  it("assigns an evening event to the local day, not the UTC day", () => {
    // 2026-01-05 19:00 America/Chicago is 2026-01-06 01:00 UTC.
    const at = Date.UTC(2026, 0, 6, 1, 0, 0);
    expect(dateInTimeZone(at, "UTC")).toBe("2026-01-06");
    expect(dateInTimeZone(at, "America/Chicago")).toBe("2026-01-05");
  });

  it("resolves local midnight across a DST spring-forward", () => {
    // US DST began 2026-03-08. Chicago is UTC-6 before, UTC-5 after.
    const before = startOfDateInTimeZone("2026-03-07", "America/Chicago");
    const after = startOfDateInTimeZone("2026-03-09", "America/Chicago");
    expect(new Date(before).toISOString()).toBe("2026-03-07T06:00:00.000Z");
    expect(new Date(after).toISOString()).toBe("2026-03-09T05:00:00.000Z");
  });

  it("a DST day is 23 hours long, so fixed 24h stepping would drift", () => {
    const dayStart = startOfDateInTimeZone("2026-03-08", "America/Chicago");
    const nextDay = startOfDateInTimeZone("2026-03-09", "America/Chicago");
    expect(nextDay - dayStart).toBe(23 * HOUR);
  });

  it("addCalendarDays crosses month boundaries", () => {
    expect(addCalendarDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rejects an unresolvable zone", () => {
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("recap uses the configured zone", () => {
  it("splits duty time on the local midnight", () => {
    // 22:00 → 02:00 Chicago, i.e. 2 hours on each side of local midnight.
    const start = Date.UTC(2026, 0, 6, 4, 0, 0); // 2026-01-05 22:00 Chicago
    const segments = [
      { status: "driving" as const, start, end: start + 4 * HOUR },
    ];

    const utc = deriveRecap(segments, start + 4 * HOUR, [], "UTC");
    // In UTC the whole block lands on 2026-01-06.
    expect(utc).toHaveLength(1);
    expect(utc[0].date).toBe("2026-01-06");
    expect(utc[0].drivingSeconds).toBe(4 * 3600);

    const chicago = deriveRecap(
      segments,
      start + 4 * HOUR,
      [],
      "America/Chicago",
    );
    expect(chicago.map((day) => day.date)).toEqual([
      "2026-01-05",
      "2026-01-06",
    ]);
    expect(chicago[0].drivingSeconds).toBe(2 * 3600);
    expect(chicago[1].drivingSeconds).toBe(2 * 3600);
  });

  it("does not double-count a day that both the recap and the events cover", () => {
    const start = Date.UTC(2026, 0, 5, 12, 0, 0);
    const segments = [
      { status: "driving" as const, start, end: start + 3 * HOUR },
    ];
    const existing: RecapDay[] = [
      {
        date: "2026-01-05",
        onDutySeconds: 0,
        drivingSeconds: 3 * 3600,
        offDutySeconds: 0,
        sleeperSeconds: 0,
      },
    ];

    const recap = deriveRecap(segments, start + 3 * HOUR, existing, "UTC");
    const day = recap.find((d) => d.date === "2026-01-05");
    // Three hours, not six. The events are the source for days they cover.
    expect(day?.drivingSeconds).toBe(3 * 3600);
  });
});

describe("cycle accounting without recap rows", () => {
  function drivingOn(date: string, hours: number, id: string): DutyEvent {
    const start = startOfDateInTimeZone(date, "UTC") + 8 * HOUR;
    return {
      id,
      driverId: "d1",
      status: "driving",
      startedAt: start,
      endedAt: start + hours * HOUR,
      source: "driver",
    };
  }

  it("falls back to events when a recap row is missing", () => {
    const config: HosConfig = {
      cycleRule: "70_8",
      reminderLeadSeconds: 1800,
      homeTerminalTimezone: "UTC",
    };
    // 6 prior days of 10 hours driving each = 60 hours on duty.
    const events = [
      drivingOn("2026-01-01", 10, "a"),
      drivingOn("2026-01-02", 10, "b"),
      drivingOn("2026-01-03", 10, "c"),
      drivingOn("2026-01-04", 10, "d"),
      drivingOn("2026-01-05", 10, "e"),
      drivingOn("2026-01-06", 10, "f"),
    ];
    const asOf = startOfDateInTimeZone("2026-01-07", "UTC") + 8 * HOUR;

    // No recap rows at all — the rollup job has not run yet.
    const result = computeHos({ events, config, asOf, recapDays: [] });

    // 70h cycle minus the 60h already worked leaves 10h, not the full 70h.
    // Reading only recap rows would have reported 70h available.
    expect(result.snapshot.cycleRemainingMs).toBe(10 * HOUR);
  });
});

describe("driving clock attribution", () => {
  it("reports the binding limit without overstating drive time", () => {
    const config: HosConfig = {
      cycleRule: "70_8",
      reminderLeadSeconds: 1800,
      homeTerminalTimezone: "UTC",
    };
    const shiftStart = Date.UTC(2026, 0, 5, 6, 0, 0);
    const events: DutyEvent[] = [
      {
        id: "on",
        driverId: "d1",
        status: "on_duty_not_driving",
        startedAt: shiftStart,
        endedAt: shiftStart + 13 * HOUR,
        source: "driver",
      },
      {
        id: "drive",
        driverId: "d1",
        status: "driving",
        startedAt: shiftStart + 13 * HOUR,
        endedAt: shiftStart + 13.5 * HOUR,
        source: "driver",
      },
    ];
    const asOf = shiftStart + 13.5 * HOUR;
    const result = computeHos({ events, config, asOf });

    // 30 minutes of the 14-hour window remain, so that is all they may drive.
    expect(result.snapshot.dutyWindowRemainingMs).toBe(0.5 * HOUR);
    expect(result.snapshot.drivingRemainingMs).toBe(0.5 * HOUR);
    // But the 11-hour clock itself still has 10.5 hours on it. Conflating the
    // two makes a window cutoff look like a driving-limit cutoff.
    expect(result.snapshot.drivingLimitRemainingMs).toBe(10.5 * HOUR);
  });
});
