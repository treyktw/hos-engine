import {
  BREAK_MINIMUM_MS,
  BREAK_REQUIRED_AFTER_MS,
  DRIVING_LIMIT_MS,
  DUTY_WINDOW_MS,
  RESET_MINIMUM_MS,
} from "./constants";

const DRIVING_LIMIT_S = DRIVING_LIMIT_MS / 1000;
const DUTY_WINDOW_S = DUTY_WINDOW_MS / 1000;
const BREAK_REQUIRED_AFTER_S = BREAK_REQUIRED_AFTER_MS / 1000;
const BREAK_MINIMUM_S = BREAK_MINIMUM_MS / 1000;
const RESET_MINIMUM_S = RESET_MINIMUM_MS / 1000;
const FUEL_STOP_S = 30 * 60; // assumed dwell for a planned fuel stop

export type RouteHosInsertionType = "break" | "fuel" | "overnight";

export type RouteHosInsertion = {
  type: RouteHosInsertionType;
  /** Index of the section the driver finishes before stopping (-1 = before first). */
  afterSectionIndex: number;
  /** Cumulative driving seconds elapsed at the stop. */
  atDrivingSecond: number;
  durationSeconds: number;
  reason: string;
};

export type RouteHosProjectionInput = {
  drivingRemainingSeconds: number;
  dutyWindowRemainingSeconds: number;
  /** Seconds of driving until a 30-minute break is required; null = not tracked. */
  breakRequiredInSeconds: number | null;
  cycleRemainingSeconds: number;
  /** Per-section driving durations from the provider route, in seconds. */
  sectionDurationsSeconds: number[];
  /** Optional planned-fuel interval in seconds; omit/null to skip fuel stops. */
  fuelIntervalSeconds?: number | null;
};

export type RouteHosProjection = {
  hosVersion: "v1";
  legality: "legal" | "warning" | "illegal";
  breaksRequired: number;
  overnightRequired: boolean;
  insertions: RouteHosInsertion[];
  /** Driving time plus all inserted stop durations. */
  hosAwareEtaSeconds: number;
  totalDrivingSeconds: number;
  warnings: string[];
};

/**
 * Project a driver's Hours-of-Service forward over a planned route to estimate
 * where required breaks / overnight resets fall and whether the trip is legal.
 *
 * This is an HOS-AWARE ESTIMATE, not a certification. It walks provider section
 * durations against the driver's remaining 11h driving / 14h duty / 8h-to-break
 * counters, inserting stops at section boundaries when a limit is hit. The
 * server remains the authority for actual HOS state via `computeHos`.
 *
 * Assumptions (intentionally conservative):
 * - A 30-minute break and a fuel stop consume wall-clock, so they also draw
 *   down the 14h duty window; they do not extend driving time.
 * - An overnight is a 10h off-duty reset that restores the 11h/14h/8h counters.
 * - Cycle limits are surfaced as a warning, not modeled minute-by-minute.
 */
export function projectHosAlongRoute(
  input: RouteHosProjectionInput,
): RouteHosProjection {
  const sections = input.sectionDurationsSeconds.filter(
    (duration) => Number.isFinite(duration) && duration > 0,
  );
  const totalDrivingSeconds = sections.reduce((sum, d) => sum + d, 0);

  // Already out of hours: cannot legally start driving now.
  if (
    input.drivingRemainingSeconds <= 0 ||
    input.dutyWindowRemainingSeconds <= 0
  ) {
    return illegal(
      totalDrivingSeconds,
      "Driver has no remaining driving or on-duty time and cannot start this route.",
    );
  }
  if (input.cycleRemainingSeconds <= 0) {
    return illegal(
      totalDrivingSeconds,
      "Driver has no remaining cycle hours; a 34-hour restart is required.",
    );
  }

  const insertions: RouteHosInsertion[] = [];
  const warnings: string[] = [];
  let breaksRequired = 0;
  let overnightRequired = false;

  let drivingLeft = input.drivingRemainingSeconds;
  let dutyLeft = input.dutyWindowRemainingSeconds;
  let breakLeft = input.breakRequiredInSeconds ?? BREAK_REQUIRED_AFTER_S;
  let fuelLeft =
    input.fuelIntervalSeconds && input.fuelIntervalSeconds > 0
      ? input.fuelIntervalSeconds
      : null;

  let cumulativeDriving = 0;
  const maxInsertions = sections.length * 4 + 12; // loop guard

  for (let index = 0; index < sections.length; index += 1) {
    let remaining = sections[index] ?? 0;

    while (remaining > 0) {
      if (insertions.length > maxInsertions) {
        warnings.push(
          "Route is too long to project Hours-of-Service reliably; treat the estimate with caution.",
        );
        remaining = 0;
        break;
      }

      // No driving or duty capacity left -> overnight reset.
      if (drivingLeft <= 0 || dutyLeft <= 0) {
        insertions.push({
          type: "overnight",
          afterSectionIndex: index - 1,
          atDrivingSecond: cumulativeDriving,
          durationSeconds: RESET_MINIMUM_S,
          reason: "10-hour reset required before the driver can continue legally.",
        });
        overnightRequired = true;
        drivingLeft = DRIVING_LIMIT_S;
        dutyLeft = DUTY_WINDOW_S;
        breakLeft = BREAK_REQUIRED_AFTER_S;
        continue;
      }

      // 8h cumulative driving reached -> mandatory 30-minute break.
      if (breakLeft <= 0) {
        insertions.push({
          type: "break",
          afterSectionIndex: index - 1,
          atDrivingSecond: cumulativeDriving,
          durationSeconds: BREAK_MINIMUM_S,
          reason: "30-minute break required after 8 hours of driving.",
        });
        breaksRequired += 1;
        breakLeft = BREAK_REQUIRED_AFTER_S;
        dutyLeft -= BREAK_MINIMUM_S; // wall-clock passes during the break
        continue;
      }

      // Planned fuel stop.
      if (fuelLeft !== null && fuelLeft <= 0) {
        insertions.push({
          type: "fuel",
          afterSectionIndex: index - 1,
          atDrivingSecond: cumulativeDriving,
          durationSeconds: FUEL_STOP_S,
          reason: "Planned fuel stop.",
        });
        fuelLeft = input.fuelIntervalSeconds ?? null;
        dutyLeft -= FUEL_STOP_S;
        continue;
      }

      // Drive up to the next binding constraint.
      const limits = [drivingLeft, dutyLeft, breakLeft, remaining];
      if (fuelLeft !== null) {
        limits.push(fuelLeft);
      }
      const step = Math.min(...limits);
      remaining -= step;
      drivingLeft -= step;
      dutyLeft -= step;
      breakLeft -= step;
      cumulativeDriving += step;
      if (fuelLeft !== null) {
        fuelLeft -= step;
      }
    }
  }

  const insertedSeconds = insertions.reduce(
    (sum, insertion) => sum + insertion.durationSeconds,
    0,
  );

  let legality: RouteHosProjection["legality"] = "legal";
  if (overnightRequired) {
    legality = "warning";
  }
  if (input.cycleRemainingSeconds < totalDrivingSeconds) {
    legality = "warning";
    warnings.push(
      "Route exceeds the driver's remaining cycle hours; a 34-hour restart will be required to finish.",
    );
  }

  return {
    hosVersion: "v1",
    legality,
    breaksRequired,
    overnightRequired,
    insertions,
    hosAwareEtaSeconds: totalDrivingSeconds + insertedSeconds,
    totalDrivingSeconds,
    warnings,
  };
}

function illegal(
  totalDrivingSeconds: number,
  reason: string,
): RouteHosProjection {
  return {
    hosVersion: "v1",
    legality: "illegal",
    breaksRequired: 0,
    overnightRequired: false,
    insertions: [],
    hosAwareEtaSeconds: totalDrivingSeconds,
    totalDrivingSeconds,
    warnings: [reason],
  };
}
