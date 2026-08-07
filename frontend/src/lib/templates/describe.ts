/**
 * Template description and label mapping (P4): output-spec descriptions + the
 * English labels for rule/capability enumerations.
 * Display-only pure functions; the single source for capability restriction
 * phrases is ./disclosure.ts (round-3 convention); this file only maps enum
 * values → labels and never writes a second restriction mapping.
 */

import type { OutputProfile } from "./types";

/** Keeps the original output verbatim (shared by card and detail page; the
 * copy must not be rewritten) */
export function outputDescription(output: OutputProfile): string {
  switch (output.kind) {
    case "exact_pixels":
      return `${output.widthPx}×${output.heightPx} pixels`;
    case "ranged_pixels":
      return `${output.minWidthPx}–${output.maxWidthPx}×${output.minHeightPx}–${output.maxHeightPx} pixels, default ${output.defaultWidthPx}×${output.defaultHeightPx}`;
    case "physical_raster":
      return `${output.widthMm}×${output.heightMm} mm (${output.printPpi} ppi → ${output.widthPx}×${output.heightPx} pixels)`;
    case "portal_source":
      return "Cropping performed by the official portal";
    case "guidance_only":
      return "Capture guidance only, no file produced";
  }
}

const ENFORCEMENT_LABELS: Record<string, string> = {
  mandatory: "Mandatory",
  recommended: "Recommended",
};

const EVALUATION_LABELS: Record<string, string> = {
  automatic: "Automatic",
  manual: "Manual",
  automatic_with_manual_confirmation: "Automatic + manual confirmation",
};

const CAPABILITY_VALUE_LABELS: Record<string, string> = {
  allowed: "Allowed",
  warn: "Warning",
  forbidden: "Forbidden",
  not_confirmed: "Not confirmed",
  certified_only: "Certified channel only",
};

const PROVENANCE_LABELS: Record<string, string> = {
  source_literal: "Source text",
  derived: "Derived",
  portal_verified: "Portal-verified",
};

const NORMALIZATION_LABELS: Record<string, string> = {
  server_authoritative: "Server-authoritative",
  client_hint: "Client hint",
};

/** Unknown values are returned verbatim (provenance is a bare string; must not
 * be written as an exhaustive switch) */
export function labelFor(table: Record<string, string>, value: string): string {
  return table[value] ?? value;
}

export function enforcementLabel(value: string): string {
  return labelFor(ENFORCEMENT_LABELS, value);
}

export function evaluationLabel(value: string): string {
  return labelFor(EVALUATION_LABELS, value);
}

export function capabilityValueLabel(value: string): string {
  return labelFor(CAPABILITY_VALUE_LABELS, value);
}

export function provenanceLabel(value: string): string {
  return labelFor(PROVENANCE_LABELS, value);
}

export function normalizationLabel(value: string): string {
  return labelFor(NORMALIZATION_LABELS, value);
}
