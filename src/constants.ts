// FMCSA Property-Carrying Rules (all in milliseconds)
export const DRIVING_LIMIT_MS = 11 * 60 * 60 * 1000; // 11 hours
export const DUTY_WINDOW_MS = 14 * 60 * 60 * 1000; // 14 hours
export const BREAK_REQUIRED_AFTER_MS = 8 * 60 * 60 * 1000; // 8 hours cumulative driving
export const BREAK_MINIMUM_MS = 30 * 60 * 1000; // 30 minutes
export const RESET_MINIMUM_MS = 10 * 60 * 60 * 1000; // 10 hours off-duty/sleeper
export const CYCLE_RESTART_MS = 34 * 60 * 60 * 1000; // 34 hours consecutive off
export const ADVERSE_DRIVING_EXTENSION_MS = 2 * 60 * 60 * 1000;
export const SIXTEEN_HOUR_WINDOW_MS = 16 * 60 * 60 * 1000;
export const SHORT_HAUL_RADIUS_AIR_MILES = 150;
export const SPLIT_SLEEPER_LONG_MINIMUM_MS = 7 * 60 * 60 * 1000;
export const SPLIT_SLEEPER_SHORT_MINIMUM_MS = 2 * 60 * 60 * 1000;
export const SPLIT_SLEEPER_TOTAL_MINIMUM_MS = 10 * 60 * 60 * 1000;
export const CYCLE_60_7_MS = 60 * 60 * 60 * 1000; // 60 hours in 7 days
export const CYCLE_70_8_MS = 70 * 60 * 60 * 1000; // 70 hours in 8 days
export const CYCLE_60_7_DAYS = 7;
export const CYCLE_70_8_DAYS = 8;

// Source priority (higher = wins ties)
export const SOURCE_PRIORITY: Record<string, number> = {
  admin_edit: 3,
  driver: 2,
  auto: 1,
};
