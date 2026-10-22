import type { HosSnapshot, HosViolation, DutyStatus } from "./types";
import {
  DRIVING_LIMIT_MS,
  DUTY_WINDOW_MS,
  BREAK_REQUIRED_AFTER_MS,
} from "./constants";

export type Segment = { status: DutyStatus; start: number; end: number };

export type ViolationContext = {
  stateStart: number;
  drivingLimitMs: number;
  dutyWindowLimitMs: number;
  dutyWindowElapsedMs: number;
  dutyWindowViolationStartedAt: number | null;
  breakViolationStartedAt: number | null;
  cycleLimitMs: number;
  cycleOnDutyMs: number;
};

export function deriveViolations(
  snapshot: HosSnapshot,
  segments: Segment[],
  asOf: number,
  context?: ViolationContext,
): HosViolation[] {
  const violations: HosViolation[] = [];
  const drivingLimitMs = context?.drivingLimitMs ?? DRIVING_LIMIT_MS;
  const dutyWindowLimitMs = context?.dutyWindowLimitMs ?? DUTY_WINDOW_MS;
  const stateStart = context?.stateStart ?? segments[0]?.start ?? asOf;

  // 11h driving violation
  if (snapshot.drivingAccumulatedMs > drivingLimitMs) {
    const overageStart = findDrivingOverageStart(
      segments,
      drivingLimitMs,
      stateStart,
    );
    violations.push({
      rule: "driving_11h",
      severity: "violation",
      startedAt: overageStart ?? asOf,
      message: `Exceeded driving limit by ${Math.round((snapshot.drivingAccumulatedMs - drivingLimitMs) / 60000)} minutes`,
    });
  }

  // 14h duty window violation
  if (snapshot.shiftStartedAt !== null) {
    const windowElapsed =
      context?.dutyWindowElapsedMs ?? asOf - snapshot.shiftStartedAt;
    if (windowElapsed > dutyWindowLimitMs) {
      violations.push({
        rule: "duty_window_14h",
        severity: "violation",
        startedAt:
          context?.dutyWindowViolationStartedAt ??
          snapshot.shiftStartedAt + dutyWindowLimitMs,
        message: `Exceeded duty window by ${Math.round((windowElapsed - dutyWindowLimitMs) / 60000)} minutes`,
      });
    }
  }

  // 30-min break violation (8h cumulative driving without break)
  const breakViolationStartedAt =
    context?.breakViolationStartedAt ??
    (snapshot.breakRequiredInMs !== null && snapshot.breakRequiredInMs <= 0
      ? findDrivingOverageStart(segments, BREAK_REQUIRED_AFTER_MS, stateStart)
      : null);
  if (breakViolationStartedAt !== null) {
    violations.push({
      rule: "break_30min",
      severity: "violation",
      startedAt: breakViolationStartedAt,
      message:
        "Required 30-minute break not taken after 8 hours of cumulative driving",
    });
  }

  // Cycle violation (checked via snapshot)
  const cycleExceeded = context
    ? context.cycleOnDutyMs > context.cycleLimitMs
    : snapshot.cycleRemainingMs <= 0;
  if (cycleExceeded) {
    violations.push({
      rule: "cycle_limit",
      severity: "violation",
      startedAt: asOf,
      message: "Exceeded cycle hours limit",
    });
  }

  return violations;
}

function findDrivingOverageStart(
  segments: Segment[],
  limitMs: number,
  rangeStart = Number.NEGATIVE_INFINITY,
): number | null {
  let accumulated = 0;
  for (const seg of segments) {
    if (seg.status === "driving" && seg.end > rangeStart) {
      const start = Math.max(seg.start, rangeStart);
      const duration = seg.end - start;
      if (accumulated + duration > limitMs) {
        // Overage started within this segment
        return start + (limitMs - accumulated);
      }
      accumulated += duration;
    }
  }
  return null;
}
