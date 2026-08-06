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
    expect(outputDescription(exact)).toBe("600×600 像素");
    expect(outputDescription(ranged)).toContain("默认 600×600");
    expect(outputDescription(physical)).toBe("35×45 毫米（300 ppi → 413×531 像素）");
    expect(outputDescription({ kind: "portal_source", officialPortalPerformsCrop: true })).toBe(
      "由官方门户执行裁剪",
    );
    expect(outputDescription({ kind: "guidance_only", reason: "内部" })).toBe(
      "仅拍摄指导，不生成文件",
    );
  });
});

describe("label tables", () => {
  it("maps known values to Chinese labels", () => {
    expect(enforcementLabel("mandatory")).toBe("强制");
    expect(enforcementLabel("recommended")).toBe("建议");
    expect(evaluationLabel("automatic")).toBe("自动判定");
    expect(capabilityValueLabel("forbidden")).toBe("禁止");
    expect(capabilityValueLabel("certified_only")).toBe("仅认证渠道");
    expect(provenanceLabel("source_literal")).toBe("来源原文");
    expect(normalizationLabel("server_authoritative")).toBe("服务端权威");
  });

  it("falls back to the raw value for unknown entries", () => {
    expect(enforcementLabel("whatever")).toBe("whatever");
    expect(capabilityValueLabel("untyped-value")).toBe("untyped-value");
    expect(provenanceLabel("")).toBe("");
  });
});
