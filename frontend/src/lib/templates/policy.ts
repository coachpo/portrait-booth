/**
 * Template capabilities → policy derivation (P2).
 * Pure functions, zero React dependencies: editor lock flags, restriction
 * lists, and the prerequisite-constraint copy on the source step.
 * This module is the single source for capabilities semantics and copy
 * (round-3 convention: policy.ts); all other modules import it and must not
 * build a second mapping.
 */

import type { Capabilities, TemplateRevision } from "./types";

export interface PolicyNotice {
  id: "crop" | "rotate" | "mirror" | "retouch" | "backgroundReplace";
  level: "warn" | "forbidden";
  /** States what is restricted + how this tool handles it */
  text: string;
}

export interface RestrictionPhrase {
  id: string;
  level: "warn" | "forbidden";
  /** TMP-002 disclosure phrase: strictly distinguishes warn (not officially
   * endorsed) from forbidden (prohibited) */
  text: string;
}

export interface SourceRequirement {
  id: "selfCapture" | "requiresOriginalCameraFile" | "requiresProfessionalPhotographer";
  text: string;
}

export interface EditorPolicy {
  /** crop === "forbidden": the user must not change composition; fixed to the
   * default cover composition */
  composeLocked: boolean;
  composeLockReason: string | null;
  rotateLocked: boolean;
  mirrorLocked: boolean;
  notices: PolicyNotice[];
  sourceRequirements: SourceRequirement[];
}

const COMPOSE_LOCKED_TEXT =
  "This template forbids adjusting the composition: the photo stays on the default cover composition, and zoom and pan are disabled.";

function noticeText(op: string, level: "warn" | "forbidden"): string {
  if (level === "forbidden") {
    return `This template forbids ${op}: this tool will not perform that operation.`;
  }
  return `This template has a warning about ${op}: check the official rules before deciding whether to proceed.`;
}

export function editorPolicy(rev: TemplateRevision): EditorPolicy {
  const caps = rev.capabilities;
  const notices: PolicyNotice[] = [];

  const add = (
    id: PolicyNotice["id"],
    op: string,
    level: "allowed" | "warn" | "forbidden",
  ): void => {
    if (level === "warn" || level === "forbidden") {
      notices.push({ id, level, text: noticeText(op, level) });
    }
  };
  add("crop", "cropping", caps.crop);
  add("rotate", "rotation", caps.rotate);
  add("mirror", "mirroring", caps.mirror);
  add("retouch", "retouching", caps.retouch);
  add("backgroundReplace", "background replacement", caps.backgroundReplace);

  const sourceRequirements: SourceRequirement[] = [];
  if (caps.selfCapture !== "allowed") {
    const text =
      caps.selfCapture === "forbidden"
        ? "This template does not allow taking the photo yourself."
        : caps.selfCapture === "certified_only"
          ? "This template requires the photo to be taken through a certified channel."
          : "This template's self-capture status has not been officially confirmed; follow the official channel's requirements.";
    sourceRequirements.push({ id: "selfCapture", text });
  }
  if (caps.requiresOriginalCameraFile) {
    sourceRequirements.push({
      id: "requiresOriginalCameraFile",
      text: "This template requires the original camera file; this tool's artifact is a re-encoded JPEG and does not satisfy that requirement.",
    });
  }
  if (caps.requiresProfessionalPhotographer) {
    sourceRequirements.push({
      id: "requiresProfessionalPhotographer",
      text: "This template requires a certified photographer; this tool does not produce certified-photographer output.",
    });
  }

  return {
    composeLocked: caps.crop === "forbidden",
    composeLockReason: caps.crop === "forbidden" ? COMPOSE_LOCKED_TEXT : null,
    rotateLocked: caps.rotate === "forbidden",
    mirrorLocked: caps.mirror === "forbidden",
    notices,
    sourceRequirements,
  };
}

/**
 * TMP-002 disclosure phrases: produced only for fields that are not
 * allowed/false; allowed fields produce no copy at all.
 * Single source for capabilities copy (round-3 convention); disclosure.ts only
 * re-exports and never builds a second mapping.
 */
export function capabilityRestrictions(caps: Capabilities): RestrictionPhrase[] {
  const out: RestrictionPhrase[] = [];
  const add = (
    id: string,
    level: "allowed" | "warn" | "forbidden",
    warnText: string,
    forbiddenText: string,
  ): void => {
    if (level === "warn") out.push({ id, level, text: warnText });
    else if (level === "forbidden") out.push({ id, level, text: forbiddenText });
  };
  add(
    "crop",
    caps.crop,
    "Cropping is not officially endorsed and may be questioned.",
    "This template forbids adjusting the composition.",
  );
  add(
    "rotate",
    caps.rotate,
    "Rotation is not officially endorsed and may be questioned.",
    "This template forbids rotation.",
  );
  add(
    "mirror",
    caps.mirror,
    "Mirroring is not officially endorsed and may be questioned.",
    "This template forbids mirroring.",
  );
  add(
    "retouch",
    caps.retouch,
    "Retouching is not officially endorsed and may be questioned.",
    "This template forbids retouching.",
  );
  add(
    "backgroundReplace",
    caps.backgroundReplace,
    "Background replacement is not officially endorsed and may be questioned.",
    "This template forbids background replacement.",
  );
  if (caps.selfCapture !== "allowed") {
    const text =
      caps.selfCapture === "forbidden"
        ? "Taking the photo yourself is not allowed."
        : caps.selfCapture === "certified_only"
          ? "The photo must be taken through a certified channel."
          : "Self-capture status has not been officially confirmed.";
    out.push({
      id: "selfCapture",
      level: caps.selfCapture === "forbidden" ? "forbidden" : "warn",
      text,
    });
  }
  if (caps.requiresOriginalCameraFile) {
    out.push({
      id: "requiresOriginalCameraFile",
      level: "forbidden",
      text: "The original camera file is required.",
    });
  }
  if (caps.requiresProfessionalPhotographer) {
    out.push({
      id: "requiresProfessionalPhotographer",
      level: "forbidden",
      text: "A certified photographer is required.",
    });
  }
  return out;
}
