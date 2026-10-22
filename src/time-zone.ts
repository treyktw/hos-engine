const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Whether a string is a time zone this runtime can actually resolve.
 *
 * Worth checking before storing one: an unresolvable zone makes
 * `Intl.DateTimeFormat` throw, and that throw would surface from `computeHos`
 * — which would stop a driver from recording duty status because of a
 * mistyped setting.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    // Force validation now rather than silently producing UTC log boundaries.
    value.format(0);
    formatterCache.set(timeZone, value);
  }
  return value;
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsAt(epochMs: number, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(epochMs)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function dateInTimeZone(epochMs: number, timeZone: string): string {
  const value = partsAt(epochMs, timeZone);
  return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

/** Convert a local civil midnight to its UTC epoch, including DST changes. */
export function startOfDateInTimeZone(
  date: string,
  timeZone: string,
): number {
  const [year, month, day] = date.split("-").map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day);
  let candidate = desiredAsUtc;

  // Offset iteration converges in one or two passes for IANA zones and handles
  // the offset on the requested date rather than reusing today's offset.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = partsAt(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = desiredAsUtc - actualAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }

  return candidate;
}

export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

export function nextDateInTimeZone(date: string, timeZone: string): number {
  return startOfDateInTimeZone(addCalendarDays(date, 1), timeZone);
}
