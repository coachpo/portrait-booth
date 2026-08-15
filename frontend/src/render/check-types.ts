/**
 * Shared vocabulary of the final check summary (OUT-007, GDE-008).
 * Kept apart from checks.ts so the individual check producers
 * (checks.ts, geometry-checks.ts) can depend on it without a cycle.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "unknown" | "manual";

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** Unified disclaimer for heuristic checks: these thresholds are not
 * officially calibrated and constitute no acceptance promise. */
export const HEURISTIC_NOTICE = "heuristic judgment, not calibrated to official tolerance";
