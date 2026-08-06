export type DocumentType = "passport" | "visa" | "id" | "permit" | "portrait";
export type SubmissionChannel =
  "paper" | "digital_upload" | "certified_transfer" | "onsite_capture";
export type ApplicantClass = "adult" | "child" | "infant" | "all";
export type PublicationStatus = "active" | "reference_only" | "deprecated" | "unsupported";

export interface TemplateSource {
  id: string;
  url: string;
  title: string;
  authority: string;
  sourceUpdatedAt?: string;
  accessedAt: string;
}

export interface Aspect {
  width: number;
  height: number;
  enforcement: "mandatory" | "recommended";
  provenance: "source_literal" | "derived" | "portal_verified";
}

export interface SizeLimit {
  minBytes?: number;
  maxBytes?: number;
  sourceLiteral: string;
  normalization: "source_exact" | "conservative_derived" | "portal_verified" | "unresolved";
}

export interface OutputFile {
  mime: string[];
  sizeLimit?: SizeLimit;
  colorSpace?: "sRGB";
  bitsPerChannel?: 8;
  channels?: 3;
  maxCompressionRatio?: number;
}

export type OutputProfile =
  | {
      kind: "exact_pixels";
      widthPx: number;
      heightPx: number;
      aspect: Aspect;
    }
  | {
      kind: "ranged_pixels";
      minWidthPx: number;
      minHeightPx: number;
      maxWidthPx: number;
      maxHeightPx: number;
      defaultWidthPx: number;
      defaultHeightPx: number;
      aspect: Aspect;
      allowedSizes?: Array<{ widthPx: number; heightPx: number }>;
    }
  | {
      kind: "physical_raster";
      widthMm: number;
      heightMm: number;
      printPpi: number;
      rounding: "nearest";
      widthPx: number;
      heightPx: number;
      pixelDerivation: "round(mm / 25.4 * printPpi)";
      ppiProvenance: "source_literal" | "derived" | "portal_verified";
      calibrationProfileId: string;
    }
  | {
      kind: "portal_source";
      officialPortalPerformsCrop: boolean;
      minWidthPx?: number;
      minHeightPx?: number;
      maxWidthPx?: number;
      maxHeightPx?: number;
      aspect?: Aspect;
    }
  | { kind: "guidance_only"; reason: string };

export interface MeasurementRule {
  id: string;
  metric: string;
  min?: number;
  max?: number;
  target?: number;
  tolerance?: number;
  unit: "mm" | "px" | "ratio" | "degree";
  anchors: string[];
  axis: "x" | "y" | "angle";
  bounds: "inclusive";
  coordinateSpace: string;
  evaluation: "automatic" | "manual" | "automatic_with_manual_confirmation";
  enforcement: "mandatory" | "recommended";
  provenance: string;
  sourceRefs: string[];
  sourceLiteral?: string;
}

export interface CaptureRule {
  id: string;
  check: string;
  expected: boolean | string | number;
  evaluation: "automatic" | "manual" | "automatic_with_manual_confirmation";
  enforcement: "mandatory" | "recommended";
  provenance: string;
  sourceRefs: string[];
  sourceLiteral?: string;
}

export interface Capabilities {
  selfCapture: "allowed" | "not_confirmed" | "forbidden" | "certified_only";
  crop: "allowed" | "warn" | "forbidden";
  rotate: "allowed" | "warn" | "forbidden";
  mirror: "allowed" | "warn" | "forbidden";
  retouch: "allowed" | "warn" | "forbidden";
  backgroundReplace: "allowed" | "warn" | "forbidden";
  requiresOriginalCameraFile: boolean;
  requiresProfessionalPhotographer: boolean;
}

export interface TemplateRevision {
  revisionId: string;
  id: string;
  version: number;
  schemaVersion: number;
  label: Record<string, string>;
  jurisdiction: string;
  documentType: DocumentType;
  submissionChannel: SubmissionChannel;
  applicantClass: ApplicantClass;
  applicationPost?: string;
  applicantNationalityScope?: string[];
  residenceScope?: string[];
  visaPurposeScope?: string[];
  validFrom?: string;
  validUntil?: string;
  sources: TemplateSource[];
  output: OutputProfile;
  outputFile?: OutputFile;
  portalInputFile?: OutputFile;
  cropRules: MeasurementRule[];
  captureRules: CaptureRule[];
  overlay: { kind: string; ruleIds: string[] };
  capabilities: Capabilities;
  sourceNotes?: Record<string, string[]>;
}

export interface TemplatePublication {
  revisionId: string;
  status: PublicationStatus;
  statusReason: string;
  owner: string;
  reviewer: string;
  verifiedAt: string;
  reviewDueAt: string;
  effectiveAt: string;
  publicationRevision: number;
}

export interface TemplateEntry {
  revision: TemplateRevision;
  contentHash: string;
  publication: TemplatePublication;
}

export interface TemplateCatalog {
  schemaVersion: number;
  catalogVersion: string;
  templates: TemplateEntry[];
}
