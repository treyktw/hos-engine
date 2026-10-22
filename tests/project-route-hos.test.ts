import { describe, it, expect } from "vitest";
import { projectHosAlongRoute } from "../src/project-route-hos.js";
import type { RouteHosProjectionInput } from "../src/project-route-hos.js";

const HOUR = 3600;

// A fully-rested driver: 11h driving / 14h duty / 8h-to-break / 70h cycle.
function freshDriver(
  overrides: Partial<RouteHosProjectionInput> = {},
): RouteHosProjectionInput {
  return {
    drivingRemainingSeconds: 11 * HOUR,
    dutyWindowRemainingSeconds: 14 * HOUR,
    breakRequiredInSeconds: 8 * HOUR,
    cycleRemainingSeconds: 70 * HOUR,
    sectionDurationsSeconds: [],
    ...overrides,
  };
}

describe("projectHosAlongRoute", () => {
  it("treats a short trip well within limits as legal with no stops", () => {
    const result = projectHosAlongRoute(
      freshDriver({ sectionDurationsSeconds: [2 * HOUR] }),
    );

    expect(result.legality).toBe("legal");
    expect(result.breaksRequired).toBe(0);
    expect(result.overnightRequired).toBe(false);
    expect(result.insertions).toHaveLength(0);
    expect(result.hosAwareEtaSeconds).toBe(2 * HOUR);
  });

  it("inserts a 30-minute break when the 8-hour driving rule is hit", () => {
    const result = projectHosAlongRoute(
      freshDriver({
        breakRequiredInSeconds: 1 * HOUR,
        sectionDurationsSeconds: [2 * HOUR],
      }),
    );

    expect(result.legality).toBe("legal");
    expect(result.breaksRequired).toBe(1);
    expect(result.overnightRequired).toBe(false);
    expect(result.insertions[0]?.type).toBe("break");
    expect(result.insertions[0]?.durationSeconds).toBe(30 * 60);
    expect(result.hosAwareEtaSeconds).toBe(2 * HOUR + 30 * 60);
  });

  it("inserts an overnight reset when driving time runs out mid-route", () => {
    const result = projectHosAlongRoute(
      freshDriver({
        drivingRemainingSeconds: 1 * HOUR,
        dutyWindowRemainingSeconds: 2 * HOUR,
        breakRequiredInSeconds: 1 * HOUR,
        sectionDurationsSeconds: [3 * HOUR],
      }),
    );

    expect(result.overnightRequired).toBe(true);
    expect(result.legality).toBe("warning");
    expect(result.insertions.some((i) => i.type === "overnight")).toBe(true);
    expect(result.hosAwareEtaSeconds).toBe(3 * HOUR + 10 * HOUR);
  });

  it("marks the route illegal when the driver is already out of hours", () => {
    const result = projectHosAlongRoute(
      freshDriver({
        drivingRemainingSeconds: 0,
        sectionDurationsSeconds: [1 * HOUR],
      }),
    );

    expect(result.legality).toBe("illegal");
    expect(result.insertions).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns when the route exceeds remaining cycle hours", () => {
    const result = projectHosAlongRoute(
      freshDriver({
        cycleRemainingSeconds: 1 * HOUR,
        sectionDurationsSeconds: [2 * HOUR],
      }),
    );

    expect(result.legality).toBe("warning");
    expect(
      result.warnings.some((w) => w.toLowerCase().includes("cycle")),
    ).toBe(true);
  });

  it("handles an empty route as legal with zero ETA", () => {
    const result = projectHosAlongRoute(
      freshDriver({ sectionDurationsSeconds: [] }),
    );

    expect(result.legality).toBe("legal");
    expect(result.hosAwareEtaSeconds).toBe(0);
    expect(result.totalDrivingSeconds).toBe(0);
  });
});
