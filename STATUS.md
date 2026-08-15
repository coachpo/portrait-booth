# Project status

> Last review date based on repository evidence: 2026-08-15

## Lifecycle

Portrait Booth is in its first MVP implementation stage. The product and
technical specifications ([product overview](docs/PRODUCT.md),
[SPEC](docs/SPEC.md)) are complete and the P0 retrieval policy is decided
(`key_only_ephemeral`, staging TTL 30 days; see SPEC §1.2.1). The two main
flows - create and retrieve - are closed end to end and fully walkable;
abuse resistance and observability required for a public launch are not yet
in place (see "Known gaps").

## Current implementation

- Monorepo toolchain: `frontend/` (Vite + React + TypeScript), `backend/`
  (FastAPI + SQLite + local disk storage), `templates/` (versioned template
  data).
- Creation flow: template selection → upload/capture → **confirmation** →
  non-destructive editing → final render and check summary. "Back" only
  changes the step and never destroys downstream state; same-session
  template switches keep the photo and edit state and re-project to the new
  template's output size (normalizing mirror/rotation per the new
  capabilities); edit state is voided only when the source photo is
  replaced.
- The editor implements EDT-008 template masks: `cropRules` pixel/mm/
  normalized coordinate spaces all convert to output pixels, drawing the
  head ellipse and each allowed range with the corresponding official source
  text.
- The final check summary uses the static recheck's real results (pose,
  exposure, sharpness, crop transparency, source resolution) instead of an
  unconditional "provided in a later version". Mandatory captureRules items
  a machine cannot judge show one by one as "needs manual confirmation"
  with the official source text; the rest are "not checked". Every heuristic
  item is labeled not calibrated to official tolerance.
- `cropRules` are measured, not only drawn: the recheck's face anchors are
  captured in source-bitmap pixels and mapped through the artifact's own
  render matrix into output pixels, so mirroring and rotation are already
  folded in, and ratio/millimeter bounds resolve against the artifact's actual
  output size. Which rules can be judged follows their declared `anchors`:
  `face_center_offset_x`, `chin_bottom_margin`, and `eye_line_from_bottom`
  resolve to real landmarks and yield pass/warn with fix advice phrased as
  panning the photo; `head_height` is crown-anchored in every template that
  declares it and the face mesh has no crown point, so it reports the measured
  chin-to-hairline span as a lower bound, can warn when that bound already
  exceeds the maximum, and never passes.
- Staging/retrieval/deletion loop: anonymous save sessions, idempotency
  leases, KEY-only retrieval, single-use download tokens, delete-secret
  authorization; the retrieve page offers the delete entry, while the
  downloadable receipt (retrieval code plus delete secret) is issued by the
  staging panel at the end of the creation flow.
- App shell: global navigation, 404 fallback, ErrorBoundary, and the
  `/privacy` page (retention and other numbers all come from
  `/api/v1/service-policy`).
- Template content gate: `python -m app.template_tools validate` checks
  schemas, publication rules, reference integrity, and `contentHash`
  binding; wired into CI.
- Deployment: single-container Docker (non-root, healthcheck, read-only
  root filesystem). For local development and acceptance only; not yet
  launched.
- **Deployment prerequisite**: the image trusts no forwarded headers. When
  the reverse proxy is not on the same host, use the `FORWARDED_ALLOW_IPS`
  environment variable with the proxy's concrete address or CIDR - **never a
  wildcard**: trusting `X-Forwarded-For` from arbitrary clients completely
  defeats §9.3's per-IP rate limit, and the 6-character retrieval code space
  can be enumerated without limit. Also make sure the proxy **overwrites**
  rather than appends the header (nginx's `$proxy_add_x_forwarded_for`
  appends, so the leftmost value still comes from the client).

## Security and correctness defects fixed this round

- **SPA static fallback path traversal**: `%2e%2e%2f` encoded traversal
  could read any file inside the container unauthenticated (including the
  SQLite database and all photo objects), bypassing every control of KEY,
  rate limiting, download tokens, expiry, and deletion. Now blocked by a
  post-resolve containment check, and unimplemented API paths return 404
  instead of index.html 200.
- **HMAC root key random per process**: a container restart invalidated
  every previously issued KEY and delete secret while photos stayed for the
  TTL. Now derived from a single `PORTRAIT_SECRET_KEY_BASE` via HKDF, with
  startup refused when missing.
- **Lifecycle worker never scheduled**: cleanup only had a `__main__`
  entry, so expired photos were never revoked and user deletion only marked
  status. Now scheduled inside the API process; deletion is physical, and the
  orphan sweep carries a 15-minute age gate.
- **OUT-003 quality search ineffective**: `toBlob` received quality 40–95
  (the spec requires 0.0–1.0); UAs ignored the out-of-range values and fell
  back to the default, so ten binary-search iterations encoded the same
  result.
- **EDT-009 crop-area check was a literal pass**: combined with "rotation
  throws the crop frame outside the source", users saw all-green checks and
  an artifact with black corners. The canvas alpha is now scanned before
  encoding, and the editor automatically adds the scale rotation needs.
- **Download token consumed non-atomically**: SELECT then unconditional
  UPDATE let two concurrent requests both get the same photo.
- **Idempotency without leases**: concurrent duplicate saves each created
  a photo and the second commit hit the primary key with a 500. Now a
  primary-key lease takeover returns 409 `IDEMPOTENCY_IN_PROGRESS` with
  `Retry-After` on conflict.
- **Object-integrity MAC never verified** and bound only to name and
  length (invisible to equal-length swaps). Now binds the content digest and
  is verified on download.
- **No CSP / no HSTS site-wide**: the §9.4 baseline is now in place
  (`'wasm-unsafe-eval'` strictly not widened to `'unsafe-eval'`); long
  caching only on `/assets/`, and photo and retrieval responses stay
  `no-store`.
- **Same-origin check looked only at Origin and skipped when absent**: now
  also checks `Sec-Fetch-Site`, enforcing same-origin for browser requests.
- **Unified error contract**: `requestId` is no longer always empty, and
  422/template-404 no longer leak FastAPI's native `{"detail": ...}`.
- **Backend test isolation broken**: `Settings` defaults froze at import
  time, making `tmp_path` fixtures completely ineffective and concurrency
  behavior unverifiable. Now reads environment variables at call time.

## Pose inference: evaluated, deliberate deviation

SPEC §4.4's prose mentions moving inference into a Worker, but no
acceptance item in GDE-001~010 requires it; GDE-006 instead requires that
"the degraded path without WebGL/WASM/**Worker** can complete the full
flow". The current implementation runs on the main thread - an **evaluated,
deliberate deviation**:

- Rationale: the migration decision's original basis, "30–50 ms/frame",
  came from a code comment contradicting measurements; without the real
  distribution, a thread refactor optimizes an unmeasured quantity.
- Higher-priority defects fixed this round: `facialTransformationMatrixes`
  is **column-major** but the solver read it row-major (yaw/roll signs and
  axes swapped), the top-left 3×3 carries a uniform scale that amplifies or
  even saturates pitch, the hysteresis direction was inverted (thresholds
  tightened after entering ready), `selectPrimaryFace` degenerated to
  first-face because blendshapes are off, the rVFC loop could not be
  cancelled, inference had no frame-rate gate, and the guidance wording
  flipped body direction via the mirror flag.
- A measurement basis exists: `pose/perf.ts` collects `detectVideo`
  p50/p95 and long tasks, with the decision gate at p95 > 50 ms (the Long
  Tasks API's spec threshold).
- **Re-review condition**: single-frame p95 crosses 50 ms on the target
  hardware, INP visibly degrades during preview, or the project actively
  decides to absorb §4.4's architectural deviation first.

## Known gaps (must be addressed before a public launch)

- Backend has zero logs and zero metrics: failures are undiagnosable
  (the §9.4 field whitelist currently exists only in comments).
- §9.3's risk budget and multi-layer rate limiting are incomplete: no /24
  aggregation, no IPv6 aggregation, no exponential backoff.
- Uploads are not streamed: the whole multipart is read into memory before
  size validation; the save endpoint has no rate limit.
- Retrieval responses have no constant processing time (SAV-008 / §6.5's
  differential-timing acceptance).
- Image validation accepts polyglots with trailing data; decoding is not
  sandboxed and has no CPU/time budget.
- Consumed/expired download grants, purged photo metadata rows, and
  idempotency records past the window are deleted by the in-process cleanup
  loop (delayed at most one cleanup interval; default interval 300 s).
  In-window idempotent replays still return the same envelope;
  `PORTRAIT_IDEMPOTENCY_WINDOW_SECONDS` tunes the window.
- §5.3 template-governance automation (reviewDueAt SLA alerts, validUntil
  expiry, link checks) exists only as a CLI toolchain with no runtime
  alerting; re-confirming the publication before export/staging is also not
  implemented. The catalog cache is now `must-revalidate` and auto-invalidates
  on content changes, so the emergency-takedown signal works.
- Server-side catalog filter parameters (jurisdiction/documentType/
  channel/applicantClass with an `all` fallback) are not implemented;
  filtering still happens client-side.
- The pose model has no "don't load the model" manual path or
  pre-initialization disclosure.
- Bitmap budget metering and i18n are not implemented. Model/WASM version
  locking and build-time asset copying are: `frontend/assets-lock.json`
  registers bytes/SHA-256/source for the 3 assets, and the `npm run
  build`/`dev` pre hooks sync wasm from the npm package with byte-level
  verification and non-zero exit on failure. Note that the one-year immutable
  `/assets/*` cache sits on fixed filenames without content hashes, so model
  or SDK upgrades must also change the URL paths (the path constants in
  `landmarker.ts`). The print-ready vs reference-image distinction is
  implemented but only visible once paper templates turn active (both current
  paper templates are reference_only and unselectable in the frontend).
- P1/P2 extensions (print layout and PDF, PWA shell) are not implemented.
  Deeper quality checks are partially implemented: the static recheck gained
  eye/mouth geometry (possibly-closed eyes/open mouth, confirm-page hints
  only) and a background-uniformity heuristic (a final-summary item whose
  status can only be warn/unknown, never pass; explicitly "not checked" when
  unmeasured); the confirm page no longer claims "recheck found no obvious
  issues" when unchecked items exist. Remaining scope: uncalibrated
  thresholds (same nature as LANDMARKER_CONFIDENCE), background in the luma
  domain only (color cast needs an explicit config field plus SPEC sync), and
  the captureRules consumption chain not implemented. Among `cropRules`, the
  crown-anchored rules stay unmeasurable for want of a crown landmark
  (`head_height` everywhere, `head_top_margin` except jp-passport's
  hairline-anchored variant), while `face_width`, `interpupil_distance`, and
  the left/right face margins are measurable but not consumed yet. Optional
  ranged_pixels sizes are implemented: us-visa-digital can switch 600/1200
  bands on the confirm page, through the editor, final page, and staging
  validation.
- Playwright end-to-end tests are not wired into CI and must be run
  manually.
- **The Public Beta minimum template manifest is not met**: 3 of the 6 hard
  gates are still `reference_only` (us-passport-paper and
  jp-passport-paper lack calibrated PPI print tests;
  cn-visa-digital-ma-rabat lacks portal verification), leaving only 2
  official templates that actually produce document artifacts. Closing this
  requires measured evidence from official sources; it is content work.

## Recorded decisions

- No "recent works" local history: it conflicts with §9.2 "edit state
  lives only in session memory".
- No PNG/TIFF multi-format export or batch photos: acceptance channels
  commonly require JPEG; PNG cannot go through OUT-003's size search, and
  the browser has no TIFF encoder; once a non-JPEG is exported it is no
  longer the staged blob, breaking OUT-001's "one immutable final artifact"
  model. If genuinely needed, the corresponding OUT item must first be added
  to SPEC §4.6.

## Data and compatibility

- The repository itself contains no user photos, runtime databases, or
  application-generated data.
- There are no production-verified browser, API, configuration, or storage
  compatibility promises today; target browsers and lifecycle constraints
  follow the [SPEC](docs/SPEC.md) implementation draft.

## Permitted changes

- Implement and fix the application per the [product overview](docs/PRODUCT.md)
  and [SPEC](docs/SPEC.md).
- Maintain the toolchain, runtime code, and automated tests, keeping the
  stable commands recorded in sync.
- Implement confirmed requirements without weakening privacy, security,
  template traceability, or output consistency.

## Forbidden changes

- Describe planned features as shipped or available without
  implementation and verification evidence.
- Present heuristic photo checks as government-approved, officially
  certified, or guaranteed to be accepted.
- Commit credentials, private photos, personal data, local environment
  files, or test material that cannot be safely made public.
- Loosen security constraints on photo staging, KEY retrieval, logging,
  caching, or deletion without verification.

## Re-review conditions

This file must be re-reviewed when introducing external users, a
production deployment, non-discardable data, a public API, or browser
compatibility promises.
