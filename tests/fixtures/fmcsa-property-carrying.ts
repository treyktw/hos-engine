import type { DutyEvent, HosConfig, RecapDay } from "../../src/types.js";

/**
 * Scenario inputs for 49 CFR 395.3(a)(3)(ii), 395.3(c), and the exceptions in
 * 395.1(b)(1), (e)(1), (g)(1), and (o). Keep these as timeline facts rather
 * than implementation-specific unit cases so they can be ported to Rust.
 */

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const FMCSA_BASE = Date.parse("2025-01-08T00:00:00.000Z");

export const BASE_CONFIG: HosConfig = {
  cycleRule: "60_7",
  reminderLeadSeconds: 30 * 60,
  homeTerminalTimezone: "UTC",
};

export function event(
  id: string,
  status: DutyEvent["status"],
  startHour: number,
  endHour?: number,
): DutyEvent {
  return {
    id,
    driverId: "fmcsa-fixture-driver",
    status,
    startedAt: FMCSA_BASE + startHour * HOUR_MS,
    ...(endHour === undefined
      ? {}
      : { endedAt: FMCSA_BASE + endHour * HOUR_MS }),
    source: "driver",
  };
}

export const PRE_RESTART_RECAP: RecapDay[] = [
  {
    date: "2025-01-05",
    onDutySeconds: 0,
    drivingSeconds: 10 * 3_600,
    offDutySeconds: 14 * 3_600,
    sleeperSeconds: 0,
  },
  {
    date: "2025-01-06",
    onDutySeconds: 10 * 3_600,
    drivingSeconds: 10 * 3_600,
    offDutySeconds: 4 * 3_600,
    sleeperSeconds: 0,
  },
  {
    date: "2025-01-07",
    onDutySeconds: 9 * 3_600,
    drivingSeconds: 10 * 3_600,
    offDutySeconds: 5 * 3_600,
    sleeperSeconds: 0,
  },
];

export const SCENARIOS = {
  onDutyBreak: [
    event("break-drive-1", "driving", 0, 8),
    event("break-on-duty", "on_duty_not_driving", 8, 8.5),
    event("break-drive-2", "driving", 8.5, 9.5),
  ],
  restart34: [
    event("restart-off", "off_duty", 0, 34),
    event("restart-drive", "driving", 34, 35),
  ],
  splitEightTwo: [
    event("82-on-duty", "on_duty_not_driving", 0, 1),
    event("82-drive-1", "driving", 1, 6),
    event("82-sleeper", "sleeper_berth", 6, 14),
    event("82-drive-2", "driving", 14, 19),
    event("82-off", "off_duty", 19, 21),
    event("82-drive-3", "driving", 21, 22),
  ],
  splitSevenThree: [
    event("73-on-duty", "on_duty_not_driving", 0, 1),
    event("73-drive-1", "driving", 1, 5),
    event("73-off", "off_duty", 5, 8),
    event("73-drive-2", "driving", 8, 13),
    event("73-sleeper", "sleeper_berth", 13, 20),
    event("73-drive-3", "driving", 20, 22),
  ],
  adverseDriving: [
    event("adverse-drive-1", "driving", 0, 8),
    event("adverse-break", "on_duty_not_driving", 8, 8.5),
    event("adverse-drive-2", "driving", 8.5, 12.5),
  ],
  sixteenHour: [
    event("16-on-duty-1", "on_duty_not_driving", 0, 5),
    event("16-drive-1", "driving", 5, 13),
    event("16-break", "on_duty_not_driving", 13, 13.5),
    event("16-on-duty-2", "on_duty_not_driving", 13.5, 15),
    event("16-drive-2", "driving", 15, 15.5),
  ],
  shortHaulNoBreak: [event("short-haul-drive", "driving", 0, 9)],
  multipleOpenEvents: [
    event("open-drive", "driving", 0),
    event("open-on-duty", "on_duty_not_driving", 2),
    event("open-off-duty", "off_duty", 3),
  ],
} as const;
