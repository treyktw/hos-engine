/**
 * Demo: compute a driver's live HOS clocks from a synthetic duty timeline,
 * then project those clocks over a planned multi-section route to see where
 * breaks and an overnight reset have to go.
 *
 * Run: pnpm demo
 */
import { computeHos, projectHosAlongRoute, type DutyEvent } from "../src";

const HOUR_MS = 3_600_000;
const shiftStart = Date.parse("2026-03-02T12:00:00Z"); // 06:00 in America/Chicago

function event(
  id: string,
  status: DutyEvent["status"],
  startHours: number,
  endHours?: number,
): DutyEvent {
  return {
    id,
    driverId: "driver-demo",
    status,
    startedAt: shiftStart + startHours * HOUR_MS,
    endedAt: endHours === undefined ? undefined : shiftStart + endHours * HOUR_MS,
    source: "driver",
  };
}

// Synthetic morning: 10h off duty, 30 min pre-trip, 4.5h driving, still driving.
const events: DutyEvent[] = [
  event("e1", "off_duty", -10, 0),
  event("e2", "on_duty_not_driving", 0, 0.5),
  event("e3", "driving", 0.5, 5),
  event("e4", "driving", 5),
];

const asOf = shiftStart + 5 * HOUR_MS;
const { snapshot, alerts } = computeHos({
  events,
  recapDays: [],
  config: {
    cycleRule: "70_8",
    reminderLeadSeconds: 1800,
    homeTerminalTimezone: "America/Chicago",
  },
  asOf,
});

const hours = (ms: number | null) =>
  ms === null ? "n/a" : `${(ms / HOUR_MS).toFixed(2)}h`;

console.log("Live clocks at", new Date(asOf).toISOString());
console.log({
  currentStatus: snapshot.currentStatus,
  drivingRemaining: hours(snapshot.drivingRemainingMs),
  dutyWindowRemaining: hours(snapshot.dutyWindowRemainingMs),
  breakRequiredIn: hours(snapshot.breakRequiredInMs),
  cycleRemaining: hours(snapshot.cycleRemainingMs),
  alerts: alerts.length,
});

// The rest of the trip, as per-section drive times from a routing provider
// (for example the candidate a truck-aware router picked).
const plan = projectHosAlongRoute({
  drivingRemainingSeconds: snapshot.drivingRemainingMs / 1000,
  dutyWindowRemainingSeconds: snapshot.dutyWindowRemainingMs / 1000,
  breakRequiredInSeconds:
    snapshot.breakRequiredInMs === null ? null : snapshot.breakRequiredInMs / 1000,
  cycleRemainingSeconds: snapshot.cycleRemainingMs / 1000,
  sectionDurationsSeconds: [3 * 3600, 4 * 3600, 5 * 3600],
  fuelIntervalSeconds: 6 * 3600,
});

console.log("\nRoute HOS projection");
console.log({
  legality: plan.legality,
  breaksRequired: plan.breaksRequired,
  overnightRequired: plan.overnightRequired,
  totalDriving: `${(plan.totalDrivingSeconds / 3600).toFixed(2)}h`,
  hosAwareEta: `${(plan.hosAwareEtaSeconds / 3600).toFixed(2)}h`,
});
for (const insertion of plan.insertions) {
  console.log(
    `  - ${insertion.type.padEnd(9)} after section ${insertion.afterSectionIndex}, ` +
      `${(insertion.durationSeconds / 3600).toFixed(1)}h: ${insertion.reason}`,
  );
}
for (const warning of plan.warnings) {
  console.log(`  ! ${warning}`);
}
