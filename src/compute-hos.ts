import type {
  ComputeHosInput,
  ComputeHosResult,
  DutyStatus,
  HosAlert,
  HosConfig,
  HosSnapshot,
  RecapDay,
} from "./types";
import { normalizeEvents } from "./normalize-events";
import { deriveViolations } from "./derive-violations";
import type { Segment } from "./derive-violations";
import { deriveRecap } from "./derive-recap";
import {
  ADVERSE_DRIVING_EXTENSION_MS,
  BREAK_MINIMUM_MS,
  BREAK_REQUIRED_AFTER_MS,
  CYCLE_RESTART_MS,
  DRIVING_LIMIT_MS,
  DUTY_WINDOW_MS,
  RESET_MINIMUM_MS,
  SHORT_HAUL_RADIUS_AIR_MILES,
  SIXTEEN_HOUR_WINDOW_MS,
  SPLIT_SLEEPER_LONG_MINIMUM_MS,
  SPLIT_SLEEPER_SHORT_MINIMUM_MS,
  SPLIT_SLEEPER_TOTAL_MINIMUM_MS,
} from "./constants";
import {
  addCalendarDays,
  dateInTimeZone,
  nextDateInTimeZone,
  startOfDateInTimeZone,
} from "./time-zone";

type Interval = { start: number; end: number };

type SplitPair = {
  first: Interval;
  second: Interval;
  completedAt: number;
};

function isOffDutyOrSleeper(status: DutyStatus): boolean {
  return status === "off_duty" || status === "sleeper_berth";
}

function isOnDuty(status: DutyStatus): boolean {
  return status === "driving" || status === "on_duty_not_driving";
}

function buildSegments(input: ComputeHosInput): Segment[] {
  const events = normalizeEvents(input.events);
  const segments: Segment[] = [];

  for (const event of events) {
    if (event.startedAt >= input.asOf) continue;
    const end = Math.min(event.endedAt ?? input.asOf, input.asOf);
    if (end <= event.startedAt) continue;

    const previous = segments.at(-1);
    if (previous && event.startedAt > previous.end) {
      segments.push({
        status: "off_duty",
        start: previous.end,
        end: event.startedAt,
      });
    }

    segments.push({ status: event.status, start: event.startedAt, end });
  }

  // Unaccounted time is off duty. Without this the last closed event stays the
  // "current" status forever, and a rest period that is only implied by the
  // absence of events is never seen — so a completed 10-hour reset made up of
  // untracked time would not reset the shift.
  const last = segments.at(-1);
  if (last && last.end < input.asOf) {
    segments.push({ status: "off_duty", start: last.end, end: input.asOf });
  }

  return segments;
}

function mergeIntervals(
  segments: Segment[],
  qualifies: (status: DutyStatus) => boolean,
): Interval[] {
  const intervals: Interval[] = [];
  for (const segment of segments) {
    if (!qualifies(segment.status)) continue;
    const previous = intervals.at(-1);
    if (previous && previous.end === segment.start) {
      previous.end = segment.end;
    } else {
      intervals.push({ start: segment.start, end: segment.end });
    }
  }
  return intervals;
}

function latestQualifyingInterval(
  intervals: Interval[],
  minimumMs: number,
): Interval | null {
  let latest: Interval | null = null;
  for (const interval of intervals) {
    if (interval.end - interval.start >= minimumMs) latest = interval;
  }
  return latest;
}

function overlaps(first: Interval, second: Interval): boolean {
  return first.start < second.end && second.start < first.end;
}

function findLatestSplitPair(
  segments: Segment[],
  after: number = Number.NEGATIVE_INFINITY,
): SplitPair | null {
  const restPeriods = mergeIntervals(segments, isOffDutyOrSleeper).filter(
    (period) => period.end - period.start >= SPLIT_SLEEPER_SHORT_MINIMUM_MS,
  );
  const sleeperPeriods = mergeIntervals(
    segments,
    (status) => status === "sleeper_berth",
  ).filter(
    (period) => period.end - period.start >= SPLIT_SLEEPER_LONG_MINIMUM_MS,
  );

  let latest: SplitPair | null = null;
  for (const sleeper of sleeperPeriods) {
    for (const rest of restPeriods) {
      // A completed 10-hour reset starts a new calculation period; sleeper
      // periods from before that reset cannot be paired with later rests.
      if (sleeper.start < after || rest.start < after) continue;
      if (overlaps(sleeper, rest)) continue;
      if (
        sleeper.end - sleeper.start + (rest.end - rest.start) <
        SPLIT_SLEEPER_TOTAL_MINIMUM_MS
      ) {
        continue;
      }

      const [first, second] =
        sleeper.end <= rest.start ? [sleeper, rest] : [rest, sleeper];
      const candidate = { first, second, completedAt: second.end };
      if (
        latest === null ||
        candidate.completedAt > latest.completedAt ||
        (candidate.completedAt === latest.completedAt &&
          candidate.first.end > latest.first.end)
      ) {
        latest = candidate;
      }
    }
  }
  return latest;
}

function overlapDuration(
  interval: Interval,
  rangeStart: number,
  rangeEnd: number,
): number {
  return Math.max(
    0,
    Math.min(interval.end, rangeEnd) - Math.max(interval.start, rangeStart),
  );
}

function sumStatusDuration(
  segments: Segment[],
  rangeStart: number,
  rangeEnd: number,
  qualifies: (status: DutyStatus) => boolean,
): number {
  let total = 0;
  for (const segment of segments) {
    if (!qualifies(segment.status)) continue;
    total += overlapDuration(segment, rangeStart, rangeEnd);
  }
  return total;
}

function firstOnDutyAtOrAfter(
  segments: Segment[],
  stateStart: number,
): number | null {
  for (const segment of segments) {
    if (!isOnDuty(segment.status) || segment.end <= stateStart) continue;
    return Math.max(segment.start, stateStart);
  }
  return null;
}

function findDrivingThresholdCrossing(
  segments: Segment[],
  rangeStart: number,
  limitMs: number,
): number | null {
  let accumulated = 0;
  for (const segment of segments) {
    if (segment.status !== "driving" || segment.end <= rangeStart) continue;
    const start = Math.max(segment.start, rangeStart);
    const duration = segment.end - start;
    if (accumulated + duration > limitMs) {
      return start + (limitMs - accumulated);
    }
    accumulated += duration;
  }
  return null;
}

function effectiveDeadline(
  shiftStartedAt: number,
  limitMs: number,
  excluded: Interval[],
): number {
  let deadline = shiftStartedAt + limitMs;
  // Sorted, because each excluded interval pushes the deadline out and so can
  // bring a later interval inside it. Processing out of order would silently
  // drop exclusions.
  const ordered = [...excluded].sort((a, b) => a.start - b.start);
  for (const interval of ordered) {
    if (interval.end <= shiftStartedAt || interval.start >= deadline) continue;
    deadline += overlapDuration(interval, shiftStartedAt, interval.end);
  }
  return deadline;
}

function resolveRuleLimits(config: HosConfig): {
  drivingLimitMs: number;
  dutyWindowLimitMs: number;
  breakApplies: boolean;
} {
  const adverse = config.adverseDrivingConditions?.enabled === true;
  const sixteenHourClaim = config.sixteenHourShortHaul;
  const sixteenHour =
    sixteenHourClaim?.enabled === true &&
    sixteenHourClaim.previousFiveDutyToursReturnedToReportingLocation &&
    sixteenHourClaim.returnAndReleaseWithin16Hours &&
    (!sixteenHourClaim.usedWithinPrevious6Days ||
      sixteenHourClaim.cycleRestartSincePreviousUse);
  const shortHaul = config.shortHaul;
  const qualifyingShortHaul =
    shortHaul?.enabled === true &&
    Number.isFinite(shortHaul.maximumAirMilesFromReportingLocation) &&
    shortHaul.maximumAirMilesFromReportingLocation >= 0 &&
    shortHaul.maximumAirMilesFromReportingLocation <=
      SHORT_HAUL_RADIUS_AIR_MILES &&
    shortHaul.returnedToReportingLocation;

  return {
    drivingLimitMs:
      DRIVING_LIMIT_MS + (adverse ? ADVERSE_DRIVING_EXTENSION_MS : 0),
    dutyWindowLimitMs:
      adverse || sixteenHour ? SIXTEEN_HOUR_WINDOW_MS : DUTY_WINDOW_MS,
    breakApplies: !qualifyingShortHaul,
  };
}

function getCycleLimits(rule: HosConfig["cycleRule"]): {
  cycleLimitMs: number;
  cycleDays: number;
} {
  if (rule === "70_8") return { cycleLimitMs: 70 * 3_600_000, cycleDays: 8 };
  return { cycleLimitMs: 60 * 3_600_000, cycleDays: 7 };
}

function computeCycleOnDuty(
  recapDays: RecapDay[],
  segments: Segment[],
  cycleDays: number,
  asOf: number,
  timeZone: string,
  cycleRestart: Interval | null,
): number {
  const currentDate = dateInTimeZone(asOf, timeZone);
  const cutoffDate = addCalendarDays(currentDate, -(cycleDays - 1));
  const restartAt = cycleRestart?.end ?? null;
  const restartDate =
    restartAt === null ? null : dateInTimeZone(restartAt, timeZone);
  const recapByDate = new Map(recapDays.map((day) => [day.date, day]));
  let total = 0;

  // Walk the prior days of the cycle window explicitly rather than iterating
  // whatever recap rows happen to exist. Recap rows are materialised by a
  // scheduled job; if that job lags or fails, iterating the rows silently
  // under-counts the cycle and tells a driver they have hours they do not.
  // Falling back to the events means a missing row costs accuracy at worst,
  // never available hours the driver has already used.
  for (let offset = cycleDays - 1; offset >= 1; offset -= 1) {
    const date = addCalendarDays(currentDate, -offset);
    if (date < cutoffDate) continue;
    if (restartDate !== null && date <= restartDate) continue;

    const recap = recapByDate.get(date);
    if (recap) {
      total += (recap.onDutySeconds + recap.drivingSeconds) * 1000;
      continue;
    }
    total += sumStatusDuration(
      segments,
      startOfDateInTimeZone(date, timeZone),
      nextDateInTimeZone(date, timeZone),
      isOnDuty,
    );
  }

  const currentDayStart = startOfDateInTimeZone(currentDate, timeZone);
  total += sumStatusDuration(
    segments,
    restartAt === null ? currentDayStart : Math.max(currentDayStart, restartAt),
    asOf,
    isOnDuty,
  );

  // Recap for a prior restart day contains pre-restart work, so derive that
  // partial day from exact events instead.
  if (restartAt !== null && restartDate !== null && restartDate < currentDate) {
    total += sumStatusDuration(
      segments,
      restartAt,
      nextDateInTimeZone(restartDate, timeZone),
      isOnDuty,
    );
  }

  return total;
}

export function computeHos(input: ComputeHosInput): ComputeHosResult {
  const { config, asOf, recapDays = [] } = input;
  const timeZone = config.homeTerminalTimezone ?? "UTC";
  const segments = buildSegments(input);
  const rules = resolveRuleLimits(config);
  const { cycleLimitMs, cycleDays } = getCycleLimits(config.cycleRule);

  const restIntervals = mergeIntervals(segments, isOffDutyOrSleeper);
  const fullReset = latestQualifyingInterval(restIntervals, RESET_MINIMUM_MS);
  const cycleRestart = latestQualifyingInterval(
    restIntervals,
    CYCLE_RESTART_MS,
  );
  const splitPair =
    config.sleeperBerthSplit?.enabled !== false
      ? findLatestSplitPair(segments, fullReset?.end)
      : null;
  const useSplit = splitPair !== null;
  const stateStart = useSplit
    ? splitPair.first.end
    : (fullReset?.end ?? segments[0]?.start ?? asOf);
  const excludedFromWindow = useSplit ? [splitPair.second] : [];
  const shiftStartedAt = firstOnDutyAtOrAfter(segments, stateStart);

  const drivingAccumulated = sumStatusDuration(
    segments,
    stateStart,
    asOf,
    (status) => status === "driving",
  );
  const onDutyAccumulated = sumStatusDuration(
    segments,
    stateStart,
    asOf,
    isOnDuty,
  );
  const dutyWindowElapsed =
    shiftStartedAt === null
      ? 0
      : Math.max(
          0,
          asOf -
            shiftStartedAt -
            excludedFromWindow.reduce(
              (total, interval) =>
                total + overlapDuration(interval, shiftStartedAt, asOf),
              0,
            ),
        );
  const dutyWindowRemainingMs = Math.max(
    0,
    rules.dutyWindowLimitMs - dutyWindowElapsed,
  );

  const qualifyingBreaks = mergeIntervals(
    segments,
    (status) => status !== "driving",
  ).filter((interval) => interval.end - interval.start >= BREAK_MINIMUM_MS);
  const latestBreak = qualifyingBreaks.at(-1) ?? null;
  const breakCounterStart = latestBreak?.end ?? segments[0]?.start ?? asOf;
  const drivingSinceBreak = sumStatusDuration(
    segments,
    breakCounterStart,
    asOf,
    (status) => status === "driving",
  );
  const breakViolationStartedAt = rules.breakApplies
    ? findDrivingThresholdCrossing(
        segments,
        breakCounterStart,
        BREAK_REQUIRED_AFTER_MS,
      )
    : null;
  const breakRequiredInMs =
    !rules.breakApplies || drivingSinceBreak === 0
      ? null
      : Math.max(0, BREAK_REQUIRED_AFTER_MS - drivingSinceBreak);

  const cycleOnDutyMs = computeCycleOnDuty(
    recapDays,
    segments,
    cycleDays,
    asOf,
    timeZone,
    cycleRestart,
  );
  const cycleRemainingMs = Math.max(0, cycleLimitMs - cycleOnDutyMs);
  const rawDrivingRemainingMs = Math.max(
    0,
    rules.drivingLimitMs - drivingAccumulated,
  );
  const drivingRemainingMs = Math.min(
    rawDrivingRemainingMs,
    dutyWindowRemainingMs,
    cycleRemainingMs,
  );

  const lastSegment = segments.at(-1);
  const snapshot: HosSnapshot = {
    hosVersion: "v1",
    currentStatus: lastSegment?.status ?? "off_duty",
    currentStatusSince: lastSegment?.start ?? asOf,
    drivingRemainingMs,
    drivingLimitRemainingMs: rawDrivingRemainingMs,
    dutyWindowRemainingMs,
    breakRequiredInMs,
    cycleRemainingMs,
    shiftStartedAt,
    onDutyAccumulatedMs: onDutyAccumulated,
    drivingAccumulatedMs: drivingAccumulated,
    lastResetAt: useSplit ? splitPair.completedAt : (fullReset?.end ?? null),
  };

  const dutyWindowViolationStartedAt =
    shiftStartedAt === null || dutyWindowElapsed <= rules.dutyWindowLimitMs
      ? null
      : effectiveDeadline(
          shiftStartedAt,
          rules.dutyWindowLimitMs,
          excludedFromWindow,
        );
  const violations = deriveViolations(snapshot, segments, asOf, {
    stateStart,
    drivingLimitMs: rules.drivingLimitMs,
    dutyWindowLimitMs: rules.dutyWindowLimitMs,
    dutyWindowElapsedMs: dutyWindowElapsed,
    dutyWindowViolationStartedAt,
    breakViolationStartedAt,
    cycleLimitMs,
    cycleOnDutyMs,
  });
  const alerts = deriveAlerts(snapshot, config);
  const recap = deriveRecap(segments, asOf, recapDays, timeZone);
  return { snapshot, violations, alerts, recap };
}

function deriveAlerts(snapshot: HosSnapshot, config: HosConfig): HosAlert[] {
  const alerts: HosAlert[] = [];
  const leadMs = config.reminderLeadSeconds * 1000;

  // Attribute against the unclamped 11-hour clock. `drivingRemainingMs` is the
  // minimum of three limits, so alerting on it would report "driving limit
  // approaching" when the cycle or the duty window is what is actually running
  // out — and each of those has its own alert below, with its own remedy.
  if (
    snapshot.drivingLimitRemainingMs > 0 &&
    snapshot.drivingLimitRemainingMs <= leadMs
  ) {
    alerts.push({
      type: "approaching_limit",
      rule: "driving_11h",
      remainingMs: snapshot.drivingLimitRemainingMs,
      message: `Driving limit approaching: ${Math.round(snapshot.drivingLimitRemainingMs / 60000)} minutes remaining`,
    });
  }
  if (
    snapshot.dutyWindowRemainingMs > 0 &&
    snapshot.dutyWindowRemainingMs <= leadMs
  ) {
    alerts.push({
      type: "approaching_limit",
      rule: "duty_window_14h",
      remainingMs: snapshot.dutyWindowRemainingMs,
      message: `Duty window approaching: ${Math.round(snapshot.dutyWindowRemainingMs / 60000)} minutes remaining`,
    });
  }
  if (
    snapshot.breakRequiredInMs !== null &&
    snapshot.breakRequiredInMs > 0 &&
    snapshot.breakRequiredInMs <= leadMs
  ) {
    alerts.push({
      type: "approaching_limit",
      rule: "break_30min",
      remainingMs: snapshot.breakRequiredInMs,
      message: `Break required in ${Math.round(snapshot.breakRequiredInMs / 60000)} minutes`,
    });
  }
  if (snapshot.cycleRemainingMs > 0 && snapshot.cycleRemainingMs <= leadMs) {
    alerts.push({
      type: "approaching_limit",
      rule: "cycle_limit",
      remainingMs: snapshot.cycleRemainingMs,
      message: `Cycle limit approaching: ${Math.round(snapshot.cycleRemainingMs / 60000)} minutes remaining`,
    });
  }
  return alerts;
}
