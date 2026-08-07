/**
 * The creation-flow state machine.
 *
 * Two invariants:
 * 1. "Back" only changes the current step and never destroys downstream
 *    state - returning from final to edit, from edit to confirm, or switching
 *    templates within a session must all preserve the original crop
 *    parameters and undo stack, otherwise every verification restarts from
 *    scratch; on a template switch the transform is re-projected to the new
 *    template's output size;
 * 2. Edit state is invalidated only when the source photo is truly replaced;
 *    switching to a composition-locked template also invalidates it (the
 *    composition lock must not be bypassed by an inherited composition).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";

import type { SaveResponse } from "../api/save";
import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { EditorStep } from "../editor/editor-step";
import {
  reprojectEditorState,
  resolveOutputSize,
  type EditTransform,
  type EditorState,
  type OutputSizeOption,
  type ReprojectNote,
} from "../editor/edit-transform";
import { FinalPage } from "../render/final-page";
import { downloadReceipt } from "../render/staging-panel";
import { editorPolicy } from "../lib/templates/policy";
import { CaptureStep } from "./capture-step";
import { ReviewStep } from "./review-step";
import { SourceStep } from "./source-step";
import { TemplateStep } from "./template-step";

type Step = "template" | "source" | "capture" | "upload" | "review" | "edit" | "final";

interface StepGroup {
  key: string;
  label: string;
  steps: Step[];
}

const STEP_GROUPS: StepGroup[] = [
  { key: "template", label: "Choose template", steps: ["template"] },
  { key: "source", label: "Get photo", steps: ["source", "capture", "upload"] },
  { key: "review", label: "Confirm photo", steps: ["review"] },
  { key: "edit", label: "Edit", steps: ["edit"] },
  { key: "final", label: "Final checks", steps: ["final"] },
];

function groupIndexOf(step: Step): number {
  return STEP_GROUPS.findIndex((g) => g.steps.includes(step));
}

const TEMPLATE_NOTE_TEXT: Record<ReprojectNote, string> = {
  refit: "the template output size changed; crop parameters were re-fitted",
  "mirror-cleared": "the new template forbids mirroring; horizontal mirror was cancelled",
  "rotation-cleared": "the new template forbids rotation; rotation was cancelled",
  reset: "the original crop could not be kept at the new size; it was reset",
};

export function CreatePage() {
  const [step, setStep] = useState<Step>("template");
  const [selected, setSelected] = useState<TemplateEntry | null>(null);
  const [sourceMode, setSourceMode] = useState<"upload" | "camera" | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  // The user-selected output size for ranged_pixels templates (P6); null =
  // the template default band
  const [selectedSize, setSelectedSize] = useState<OutputSizeOption | null>(null);
  // Staged receipt (session memory only, never persisted): restored as-is
  // when returning from final to edit and back, so the server never ends up
  // with a second photo from this round trip (§9.2 edit state is in session
  // memory only)
  const [staged, setStaged] = useState<{
    saved: SaveResponse;
    idempotencyKey: string;
    source: SourceImage;
    transform: EditTransform;
  } | null>(null);
  // Visible note after the template-switch projection (role=status,
  // rendered on the confirm page)
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  // The current template's source prerequisites (rendered on the template
  // card and the "choose photo source" step)
  const sourcePolicy = selected ? editorPolicy(selected.revision) : null;

  // Dirty means unsaved content: leaving after only selecting a template
  // (no photo yet) loses nothing
  const dirty = !!source || !!editorState || staged !== null;
  // Unified interception of in-app navigation and the back gesture: a
  // same-path click (clicking "Create photo" while already on /create) is not
  // intercepted
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );
  const sourceRef = useRef<SourceImage | null>(null);
  const stepHeadingRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(
    () => () => {
      sourceRef.current?.dispose();
      sourceRef.current = null;
    },
    [],
  );

  // Move focus to the new step on step changes, so keyboard and
  // screen-reader users do not stay parked on the previous screen
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  // A refresh or accidental tab close drops all in-memory state: photos,
  // crop parameters, and the undo stack are never persisted (§9.2). Same
  // predicate as dirty: selecting only a template must not trigger the
  // refresh confirm (in-app navigation is intercepted by the blocker above)
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const replaceSource = useCallback((next: SourceImage | null) => {
    sourceRef.current?.dispose();
    sourceRef.current = next;
    setSource(next);
    // The source photo changed; previous crop parameters no longer
    // correspond to anything
    setEditorState(null);
  }, []);

  const restart = useCallback(() => {
    if (
      staged !== null &&
      !window.confirm(
        "This photo is already staged; restarting will lose the retrieval code and delete secret. Download the receipt first; continue?",
      )
    ) {
      return;
    }
    replaceSource(null);
    setSourceMode(null);
    setSelected(null);
    setSelectedSize(null);
    setStaged(null);
    setStep("template");
  }, [replaceSource, staged]);

  const selectedOut = selected ? resolveOutputSize(selected.revision, selectedSize) : null;

  const currentGroup = groupIndexOf(step);

  return (
    <>
      <h1>Create photo</h1>
      <ol className="step-bar" aria-label="Creation progress">
        {STEP_GROUPS.map((group, index) => (
          <li
            key={group.key}
            className={index < currentGroup ? "done" : undefined}
            aria-current={index === currentGroup ? "step" : undefined}
          >
            {index + 1}. {group.label}
          </li>
        ))}
      </ol>

      {/* The tabIndex=-1 container is only the focus landing spot after step
      switches and stays out of the Tab sequence */}
      <div ref={stepHeadingRef} tabIndex={-1}>
        {step === "template" && (
          <>
            <TemplateStep
              onSelect={(entry) => {
                setSelected(entry);
                // After a template switch the size band returns to that
                // template's default (editorState untouched; see P6 ticket 10)
                setSelectedSize(null);
                if (source === null) {
                  // First template selection: no photo yet, go to source
                  // selection as before
                  setStep("source");
                  return;
                }
                const templateChanged =
                  selected !== null && selected.revision.revisionId !== entry.revision.revisionId;
                if (editorState !== null) {
                  if (templateChanged && entry.revision.capabilities.crop === "forbidden") {
                    // The new template forbids adjusting composition: the
                    // inherited scale/translate must be voided (P2 closure)
                    setEditorState(null);
                    setTemplateNotice(
                      "the new template forbids adjusting composition; crop was reset to the default composition.",
                    );
                  } else {
                    // Same-session template switch: keep the photo and
                    // edit state, re-project to the new template
                    const { state, notes } = reprojectEditorState(
                      editorState,
                      { width: source.width, height: source.height },
                      entry.revision,
                    );
                    setEditorState(state);
                    setTemplateNotice(notes.map((n) => TEMPLATE_NOTE_TEXT[n]).join("；"));
                  }
                } else {
                  setTemplateNotice(null);
                }
                setStep("review");
              }}
            />
            {source !== null && (
              <div className="step-actions">
                <button type="button" onClick={() => setStep("review")}>
                  Back (keep current template)
                </button>
              </div>
            )}
          </>
        )}

        {step === "source" && selected && (
          <section aria-label="Choose photo source">
            <h2>Choose photo source</h2>
            <p className="muted">Upload an existing photo, or take a new one with the camera.</p>
            {sourcePolicy && sourcePolicy.sourceRequirements.length > 0 && (
              <ul className="muted">
                {sourcePolicy.sourceRequirements.map((r) => (
                  <li key={r.id}>{r.text}</li>
                ))}
              </ul>
            )}
            <div className="step-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setSourceMode("upload");
                  setStep("upload");
                }}
              >
                Upload photo
              </button>
              <button
                type="button"
                onClick={() => {
                  setSourceMode("camera");
                  setStep("capture");
                }}
              >
                Use camera capture
              </button>
            </div>
            <div className="step-actions">
              <button type="button" onClick={() => setStep("template")}>
                Back to choose another template
              </button>
            </div>
          </section>
        )}

        {step === "upload" && selected && (
          <SourceStep
            template={selected}
            onReady={(next) => {
              replaceSource(next);
              setStep("review");
            }}
            onBack={() => setStep("source")}
          />
        )}

        {step === "capture" && selected && (
          <CaptureStep
            template={selected}
            onReady={(next) => {
              replaceSource(next);
              setStep("review");
            }}
            onBack={() => setStep("source")}
          />
        )}

        {step === "review" && selected && source && (
          <ReviewStep
            source={source}
            template={selected}
            origin={sourceMode === "camera" ? "camera" : "upload"}
            selectedSize={selectedSize}
            onSizeChange={setSelectedSize}
            onConfirm={() => setStep("edit")}
            onRetake={() => {
              replaceSource(null);
              setStep(sourceMode === "camera" ? "capture" : "upload");
            }}
            onBack={() => {
              replaceSource(null);
              setStep("source");
            }}
            onChangeTemplate={() => setStep("template")}
            notice={templateNotice}
          />
        )}

        {step === "edit" && selected && source && (
          <EditorStep
            source={source}
            template={selected}
            size={selectedOut}
            initialState={editorState}
            onDone={(state) => {
              setEditorState(state);
              setStep("final");
            }}
            // Back to the confirm step: edit state is written back explicitly
            // by this callback, so returning re-enters with it intact
            onBack={(state) => {
              setEditorState(state);
              setStep("review");
            }}
          />
        )}

        {step === "final" && selected && source && editorState && (
          <FinalPage
            source={source}
            template={selected}
            transform={editorState.transform}
            selectedSize={selectedSize}
            onUseDefaultSize={() => setSelectedSize(null)}
            onBack={() => setStep("edit")}
            onRestart={restart}
            staged={staged}
            stagedStale={
              staged !== null &&
              (staged.source !== source ||
                staged.transform.translateX !== editorState.transform.translateX ||
                staged.transform.translateY !== editorState.transform.translateY ||
                staged.transform.scale !== editorState.transform.scale ||
                staged.transform.rotationDeg !== editorState.transform.rotationDeg ||
                staged.transform.flipX !== editorState.transform.flipX)
            }
            onStaged={(receipt) =>
              receipt === null
                ? setStaged(null)
                : setStaged({ ...receipt, source, transform: editorState.transform })
            }
          />
        )}
      </div>

      {blocker.state === "blocked" && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="leave-title"
          className="confirm-box"
        >
          <h3 id="leave-title">Leave the creation flow?</h3>
          {staged ? (
            <>
              <p>
                This photo has been staged successfully. The retrieval code and delete secret are
                shown only once and cannot be recovered after leaving; unsaved photos and edits
                would also be lost.
              </p>
              <div className="step-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => downloadReceipt(staged.saved)}
                >
                  Download receipt (with retrieval code and delete secret)
                </button>
              </div>
            </>
          ) : (
            <p>
              There are unsaved photos and edits (crop parameters, undo stack); leaving will lose
              them.
            </p>
          )}
          <div className="step-actions">
            <button type="button" className="primary" onClick={() => blocker.proceed()}>
              Continue leaving
            </button>
            <button type="button" onClick={() => blocker.reset()}>
              Stay on this page
            </button>
          </div>
        </div>
      )}
    </>
  );
}
