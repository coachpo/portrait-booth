import { describe, expect, it } from "vitest";

import {
  capabilityValueLabel,
  enforcementLabel,
  evaluationLabel,
  normalizationLabel,
  outputDescription,
  provenanceLabel,
} from "./describe";
import type { OutputProfile } from "./types";

describe("outputDescription", () => {
  it("covers the five output kinds", () => {
    const exact: OutputProfile = {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 600,
      aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
    };
    const ranged: OutputProfile = {
      kind: "ranged_pixels",
      minWidthPx: 600,
      maxWidthPx: 1200,
      minHeightPx: 600,
      maxHeightPx: 1200,
      defaultWidthPx: 600,
      defaultHeightPx: 600,
      aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
    };
    const physical: OutputProfile = {
      kind: "physical_raster",
      widthMm: 35,
      heightMm: 45,
      printPpi: 300,
      rounding: "nearest",
      widthPx: 413,
      heightPx: 531,
      pixelDerivation: "round(mm / 25.4 * printPpi)",
      ppiProvenance: "source_literal",
      calibrationProfileId: "none",
    };
    expect(outputDescription(exact)).toBe("600×600 pixels");
    expect(outputDescription(ranged)).toContain("default 600×600");
    expect(outputDescription(physical)).toBe("35×45 mm (300 ppi → 413×531 pixels)");
    expect(outputDescription({ kind: "portal_source", officialPortalPerformsCrop: true })).toBe(
      "Cropping performed by the official portal",
    );
    expect(outputDescription({ kind: "guidance_only", reason: "internal" })).toBe(
      "Capture guidance only, no file produced",
    );
  });
});

describe("label tables", () => {
  it("maps known values to English labels", () => {
    expect(enforcementLabel("mandatory")).toBe("Mandatory");
    expect(enforcementLabel("recommended")).toBe("Recommended");
    expect(evaluationLabel("automatic")).toBe("Automatic");
    expect(capabilityValueLabel("forbidden")).toBe("Forbidden");
    expect(capabilityValueLabel("certified_only")).toBe("Certified channel only");
    expect(provenanceLabel("source_literal")).toBe("Source text");
    expect(normalizationLabel("server_authoritative")).toBe("Server-authoritative");
  });

  it("falls back to the raw value for unknown entries", () => {
    expect(enforcementLabel("whatever")).toBe("whatever");
    expect(capabilityValueLabel("untyped-value")).toBe("untyped-value");
    expect(provenanceLabel("")).toBe("");
  });
});
