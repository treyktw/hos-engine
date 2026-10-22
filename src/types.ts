export type DutyStatus =
  | "off_duty"
  | "sleeper_berth"
  | "driving"
  | "on_duty_not_driving";

export type CycleRule = "60_7" | "70_8";

export type EventSource = "driver" | "auto" | "admin_edit";

/**
 * 49 CFR 395 Appendix A event record status. Only `active` records contribute to
 * hours-of-service. A carrier-proposed edit stays in `inactive_change_requested`
 * until the driver accepts or rejects it (395.30(c)).
 *
 * Records with no `recordStatus` are treated as `active` so that rows written
 * before this field existed keep their meaning.
 */
export type EventRecordStatus =
  | "active"
  | "inactive_changed"
  | "inactive_change_requested"
  | "inactive_change_rejected";

export type ViolationSeverity = "warning" | "violation";

export type AlertType = "approaching_limit";

export type DutyEvent = {
  id: string;
  driverId: string;
  status: DutyStatus;
  startedAt: number; // epoch ms
  endedAt?: number;
  location?: { lat: number; lng: number; label?: string };
  source: EventSource;
  editOf?: string; // ID of superseded event
  recordStatus?: EventRecordStatus; // absent === "active"
};

export type HosConfig = {
  cycleRule: CycleRule;
  reminderLeadSeconds: number; // seconds before limit to fire alerts
  /** IANA timezone used for log-day and cycle boundaries. Defaults to UTC. */
  homeTerminalTimezone?: string;
  /** Completed 7/3 or 8/2 pairings are used unless explicitly disabled. */
  sleeperBerthSplit?: { enabled: boolean };
  /**
   * An asserted use of 49 CFR 395.1(b)(1). The caller remains responsible for
   * retaining the adverse-condition evidence required by the regulation.
   */
  adverseDrivingConditions?: { enabled: boolean };
  /**
   * Facts needed to apply the 395.1(e)(1) 150-air-mile exception. This engine
   * applies the break exemption only when all three facts qualify.
   */
  shortHaul?: {
    enabled: boolean;
    maximumAirMilesFromReportingLocation: number;
    returnedToReportingLocation: boolean;
  };
  /**
   * Facts required for the once-per-period 16-hour exception in 49 CFR
   * 395.1(o). It extends only the driving window, never the 11-hour limit.
   */
  sixteenHourShortHaul?: {
    enabled: boolean;
    previousFiveDutyToursReturnedToReportingLocation: boolean;
    returnAndReleaseWithin16Hours: boolean;
    usedWithinPrevious6Days: boolean;
    /** A 34-hour restart after the previous use permits a new use. */
    cycleRestartSincePreviousUse: boolean;
  };
};

export type RecapDay = {
  date: string; // YYYY-MM-DD
  onDutySeconds: number;
  drivingSeconds: number;
  offDutySeconds: number;
  sleeperSeconds: number;
};

export type HosSnapshot = {
  hosVersion: "v1";
  currentStatus: DutyStatus;
  currentStatusSince: number;
  /**
   * Time the driver may actually still drive: the 11-hour clock clamped by the
   * duty window and the cycle. This is the number to show a driver — it never
   * overstates what they are allowed to do.
   */
  drivingRemainingMs: number;
  /**
   * The 11-hour driving clock alone, unclamped. Needed to tell which limit is
   * actually binding; without it a cycle-driven cutoff looks like an 11-hour
   * cutoff.
   */
  drivingLimitRemainingMs: number;
  dutyWindowRemainingMs: number;
  breakRequiredInMs: number | null; // null if break not yet required
  cycleRemainingMs: number;
  shiftStartedAt: number | null;
  onDutyAccumulatedMs: number;
  drivingAccumulatedMs: number;
  lastResetAt: number | null;
};

export type HosViolation = {
  rule: string;
  severity: ViolationSeverity;
  startedAt: number;
  message: string;
};

export type HosAlert = {
  type: AlertType;
  rule: string;
  remainingMs: number;
  message: string;
};

export type ComputeHosInput = {
  events: DutyEvent[];
  config: HosConfig;
  asOf: number; // epoch ms
  recapDays?: RecapDay[];
};

export type ComputeHosResult = {
  snapshot: HosSnapshot;
  violations: HosViolation[];
  alerts: HosAlert[];
  recap: RecapDay[];
};
