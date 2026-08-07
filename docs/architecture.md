# Architecture

## Current architecture status

The repository is in its first MVP implementation stage with a monorepo
toolchain: `frontend/` (Vite + React + TypeScript, browser client),
`backend/` (FastAPI + SQLite + local disk storage, staging/retrieval API and
lifecycle tasks), and `templates/` (versioned template data and JSON
Schemas). This file separates the "current repository facts" from the
"implementation boundaries" recorded in [SPEC](SPEC.md); implementation
boundaries are constraints later verification must satisfy and do not imply
all related capabilities are complete.

## Current repository structure

```text
portrait-booth/
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── STATUS.md
├── CONTRIBUTING.md
├── .github/workflows/ci.yml
├── docker-compose.yml            # full-stack container orchestration
├── Dockerfile                    # backend container (hosts the frontend build)
├── .env.example
├── templates/                    # shared template data
│   ├── revisions/                # <id>@<version>.json
│   └── schema/                   # versioned JSON Schemas
├── frontend/                     # Vite + React + TS
│   └── src/
│       ├── app/                  # app route table, Layout, ErrorBoundary
│       ├── pages/                # home / retrieve / privacy / not-found / template detail
│       ├── create/               # wizard state machine and step components (template/source/capture/review)
│       ├── camera/               # getUserMedia, capability detection, capture
│       ├── pose/                 # Face Landmarker instances, angle solving, tracking (hint keys only), hint copy formatting (guidance-text), static recheck, face-geometry heuristics, quality, performance measurement
│       ├── editor/               # non-destructive transforms, template-mask conversion, undo
│       ├── render/               # final render, FinalArtifact, check summary, JPEG/PPI, staging panel
│       ├── image/                # decode, EXIF normalization, limits
│       ├── lib/                  # template catalog client, template policy derivation (policy.ts), display pure functions (describe/disclosure), UI locale key (locale.ts), retrieval-code normalization
│       └── api/                  # fetch clients (save / service-policy)
├── frontend/e2e/                 # Playwright full flow (see CONTRIBUTING.md)
├── backend/                      # FastAPI
│   ├── app/
│   │   ├── main.py               # entry, static hosting, security headers and CSP, unified error handling
│   │   ├── config.py             # service policy (reads env per call, not frozen at import)
│   │   ├── db.py                 # SQLite schema/migrations
│   │   ├── keygen.py             # KEY generation
│   │   ├── hmac_utils.py         # root-key HKDF derivation and domain-isolated HMAC
│   │   ├── http_utils.py         # unified error envelope and same-origin enforcement
│   │   ├── image_validate.py     # decode limits and re-encoding
│   │   ├── storage.py            # on-disk object storage
│   │   ├── rate_limit.py         # rate limiting
│   │   ├── save_service.py       # idempotency leases and atomic commit boundary
│   │   ├── template_store.py     # template loading, schema validation, reference integrity
│   │   ├── template_tools.py     # template content toolchain (validate/rehash/report/new)
│   │   ├── worker.py             # lifecycle tasks (scheduled inside the API process)
│   │   └── routers/              # sessions (policy+session) / templates / saves / retrievals
│   └── tests/
└── docs/
```

Exposure and sharpness heuristics live in `pose/quality.ts`; face-geometry
heuristics (eye/mouth EAR/MAR and the ROI bounding box) live in
`pose/face-geometry.ts` (pure functions, unit-testable without canvas or
MediaPipe); the check summary lives in `render/checks.ts` - there are no
separate `quality/` or `checks/` directories. `pages/` holds only standalone
pages that do not belong to the creation flow.

## Planned system boundaries

[Product overview](PRODUCT.md) and [SPEC](SPEC.md) record the following
implementation boundaries:

- **Browser client**: template selection, file decoding, camera access,
  face-geometry analysis, non-destructive editing, final rendering, and
  local download.
- **Template service**: provides versioned photo templates with their
  sources, status, channels, and editing policies.
- **Staging and retrieval service**: accepts final photos the user
  explicitly chose to stage, assigns KEYs, and handles authorization,
  download, deletion, and expiry.
- **Image-validation boundary**: the server actually decodes and
  re-encodes staged images in isolation, trusting neither extensions, MIME,
  nor client claims.
- **Private-storage boundary**: photo objects and metadata are separate;
  objects are not public, and KEYs are never object paths.
- **Lifecycle tasks**: make expired or deleted photos lose access
  eligibility, then complete the physical cleanup.

These responsibility components are not yet mapped to concrete
directories, processes, vendors, or deployment units.

## Planned dependency direction

The main browser data flow is:

```text
upload or camera
  → orientation and color normalization
  → local pose/quality analysis
  → non-destructive editing
  → single FinalArtifact
  ├─→ local export
  └─→ staging after user confirmation
```

The server data flow is:

```text
Save API
  → isolated validation and re-encoding
  → private object storage + metadata storage
  → Resolve API
  → short-lived download capability
```

Browser analysis results, raw camera frames, source images, and edit
history must not cross the client boundary due to ordinary export. Export
and staging must branch from the same immutable final artifact so the two
paths never produce different compositions.

## Data and security boundaries

- Ordinary upload, capture, analysis, editing, and export happen in the
  browser by default.
- The final photo enters the server boundary only when the user actively
  chooses to stage.
- Staging must not include the source image, video frames, face
  landmarks, identity embeddings, or edit history.
- KEYs are fixed 6-character `[A-Z0-9]` strings, each position generated
  independently with no letter/digit quota; a KEY is never reused for
  another photo.
- A 6-character KEY space is roughly 31.0 bits and cannot count as strong
  authentication alone. A public retrieval implementation must follow the
  anti-enumeration, authorization, rate-limiting, unified-error, caching,
  and logging constraints in [SPEC](SPEC.md).
- Delete authorization and download authorization are separate; after
  expiry or deletion, access denial must not depend on whether the async
  cleanup task has run.
- Government photo rules are managed per country, document type,
  submission channel, applicant class, and source version; no single
  universal-size template covers every scenario.

## External capabilities and dependency status

Chosen stack: frontend Vite + React + TypeScript (react-router-dom for
routing; state via component-local useState, with the creation-flow state
machine concentrated in `create/create-page.tsx` and no separate state
library); backend FastAPI + SQLite (stdlib `sqlite3`) + local disk object
storage; deployment as a single Docker container (FastAPI hosts the
frontend build). The browser pose-analysis candidate is MediaPipe Face
Landmarker (same-origin self-hosted, version-locked; authoritative manifest
is `frontend/assets-lock.json`, wasm synced from the npm package by the
prebuild/predev hooks with byte-level verification), with telemetry audit
and model QA not yet done; object storage and image re-encoding (Pillow) are
used only on the server staging path. No cloud services, managed databases,
or CDNs are chosen; local disk storage satisfies the MVP deployment scope.

## Local run model

The development topology is two processes: the backend FastAPI (port
8000, SQLite + disk storage under `backend/data/`) and the frontend Vite
dev server (port 5173, `/api` proxied to 8000). The production topology is
one container: the backend hosts the frontend `dist/` build, with SQLite and
photo objects on a mounted volume. Commands are in [README](../README.md)
and the [contribution guide](../CONTRIBUTING.md).

## Main risks and exit conditions

| Risk | Current limitation | Verifiable exit condition |
| --- | --- | --- |
| No implementation | Cannot verify user flows, performance, or compatibility | Build a minimal end-to-end implementation and pass automated and real-device tests |
| Document-rule changes or mission differences | Templates in the spec are only candidates | Every enabled template has an official source, version, review record, and takedown capability |
| 6-character KEYs enumerable | KEYs cannot be treated as strong passwords | Complete the threat review and verify authorization and abuse controls before public retrieval |
| Browser camera and image API variance | Automatic guidance cannot be the only path | Support upload, manual capture, and no-model degradation, verified on target browsers |
| Image processing could leak or alter photos | Ordinary flows stay local; staging must re-encode | Network, metadata, pixel, and lifecycle tests all pass |
