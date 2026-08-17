# Development Rules

<!-- write-project-docs:development-source-size:start -->
## General Size and Responsibility Rules

Source code size, responsibility boundaries, long-file review, and splitting requirements are governed by [Source Code Size and Responsibility Rules](source-code-size-and-responsibility-rules.md).

This file does not repeat or restate the general thresholds in that dedicated policy.
<!-- write-project-docs:development-source-size:end -->

## Shared rules

The shared development workflow, design and implementation principles, and
definition of done follow the [contribution guide](../CONTRIBUTING.md).
Component responsibilities, system boundaries, and dependency orientation
follow the [architecture](architecture.md).

## Files and formatting

- Use UTF-8, LF, and a final newline.
- Indent Markdown, JSON, and YAML with two spaces; source code is governed
  by the project's formatter for the chosen language.
- Use descriptive lower-kebab-case filenames unless the framework has a
  stronger convention.
- Modules keep a single main responsibility; comments explain decisions,
  constraints, or failure modes rather than restating code.

## Directories and tests

- The monorepo layout is fixed by the framework conventions: `frontend/`
  (Vite + React + TypeScript, colocated `*.test.ts(x)` next to sources,
  Playwright specs under `e2e/`), `backend/` (FastAPI, tests under
  `tests/`), and `templates/` (versioned data and JSON Schemas).
- New behavior requires automated tests; bug fixes require regression cases
  that reproduce the problem.
- Never weaken assertions, mask legitimate errors, or remove necessary
  behavior to make checks pass.
- The stable development, test, check, and build commands are recorded in
  the [contribution guide](../CONTRIBUTING.md) and must be kept in sync
  with the actual toolchain.

## Portrait Booth implementation rules

- Uploaded files, camera frames, face geometry, and edit state stay in the
  browser by default; the final photo is uploaded only when the user
  explicitly chooses to stage.
- Camera permission can only be triggered by a user action; leaving the
  capture flow must stop all media tracks, keeping the upload and manual
  paths available.
- Editing uses non-destructive parameters; preview, export, and staging
  share the same transform math and final artifact.
- Template rules must be versioned and point to official sources; templates
  whose channel is inapplicable or which are unreviewed must not display as
  submittable artifacts.
- KEYs are 6-character `[A-Z0-9]` strings, keep leading zeros, are generated
  by an unbiased CSPRNG, and are never reused; they must not enter URLs,
  public object paths, or logs.
- Server-side image input must actually decode, bound resources, and
  re-encode; file extensions, MIME types, and client template claims are
  never trusted.
- Logs, telemetry, and error tracking must not contain photos, KEYs, access
  or delete credentials, face landmarks, object paths, or request bodies.
- Any "pass" result may only describe checked items and must not claim
  government endorsement or guaranteed acceptance.

## Security and configuration

- Never commit credentials, private media, local environment files, or
  production data.
- When adding configuration, provide a sanitized `.env.example` explaining
  each variable's purpose without real values.
- New dependencies must be directly relevant to the current scope, use
  pinned versions, and be covered by applicable vulnerability and regression
  checks.