# Repository Guidelines

## Project Structure

The repository is a monorepo:

- `frontend/` — Vite + React + TypeScript web app. Sources under `src/` with
  colocated Vitest tests; Playwright end-to-end specs under `e2e/`.
- `backend/` — FastAPI + SQLite + local disk storage. Managed with `uv`;
  tests under `tests/`; template content toolchain in `app/template_tools.py`.
- `templates/` — versioned template data (`revisions/`) and JSON Schemas (`schema/`).
- `docs/` — authoritative project documents (see the documentation navigation
  block at the end of this file).

## Build, Test, and Development Commands

Stable commands are recorded in [CONTRIBUTING.md](CONTRIBUTING.md) and verified
against the actual toolchain and CI:

- Frontend (working directory `frontend/`): `npm install`, `npm run dev`,
  `npm run build` (type check + production build), `npm test` (Vitest),
  `npm run lint`, `npm run format:check`, `npm run test:e2e` (Playwright;
  manual, not wired into CI).
- Backend (working directory `backend/`): `uv sync --extra dev`,
  `uv run uvicorn app.main:app --reload` (dev server, port 8000),
  `uv run pytest`, `uv run ruff check .`, `uv run ruff format --check .`,
  `uv run python -m app.template_tools validate` (template content gate,
  wired into CI).
- Full stack (repository root): `docker compose up --build`.

CI (`.github/workflows/ci.yml`) runs the frontend lint/format/test/build and
backend ruff/pytest/template-gate checks; Playwright end-to-end tests require
manual execution. Use `git status --short` to review the working tree and
`git diff --check` to catch whitespace errors before committing.

## Coding Style & Naming Conventions

Use UTF-8 files with LF line endings and a final newline. Indent Markdown,
JSON, and YAML with two spaces; let the configured formatters govern source
code (Prettier + ESLint for frontend, ruff for backend). Prefer descriptive,
lower-kebab-case filenames such as `portrait-preview.ts`, unless framework
conventions require otherwise. Follow language-standard naming for symbols,
keep modules focused, and comment decisions or constraints rather than
restating code.

## Testing Guidelines

Automated tests are established and run in CI: Vitest colocated with frontend
sources, pytest under `backend/tests/`, Playwright for end-to-end flows. New
behavior should arrive with automated tests; bug fixes should include a
regression case that reproduces the problem. Never weaken assertions, mask
legitimate errors, or remove necessary behavior to make checks pass.

## Commit & Pull Request Guidelines

Use Conventional Commits with concise imperative subjects, such as
`feat: add portrait capture flow` or `fix: handle denied camera access`. Keep
each commit and pull request narrowly scoped.

Pull requests should explain the purpose and approach, list validation
performed, link relevant issues, and include screenshots for visual changes.
Call out new dependencies, configuration, migrations, or follow-up work
explicitly.

## Security & Configuration

Never commit credentials, private media, local environment files, or runtime
data. `.env.example` documents each required variable (for example
`PORTRAIT_SECRET_KEY_BASE`) without real values; `.gitignore` keeps
environment and runtime data untracked. Preserve the privacy and security
boundaries described in the authoritative documents (see the navigation block
below).

<!-- write-project-docs:document-navigation:start -->
## Project Documentation Navigation

Before starting related work, read the authoritative documents that cover the scope of the task:

- [Project Status](STATUS.md)
- [Documentation Index](docs/README.md)
- [Product Overview](docs/product.md)
- [Architecture Overview](docs/architecture.md)
- [Development Rules](docs/development-rules.md)
- [Source Code Size and Responsibility Rules](docs/source-code-size-and-responsibility-rules.md)
- [Contributing Guide](CONTRIBUTING.md)

When implementing, reviewing, or verifying an engineering change, use `STATUS.md` and the product overview for current facts and delivery intent, then read the [Current Iteration Strategy](CONTRIBUTING.md#current-iteration-strategy) when that derived section exists. Consume only the required-now items, non-negotiable boundaries, and re-derivation triggers relevant to the task; do not independently expand explicitly deferred or currently untriggered work. A new user requirement, active Goal, reachable risk, hard project rule or invariant, or evidence-backed review finding overrides a conflicting deferred description. The strategy does not expand user authorization, and the MVP Fast Validation switch neither defines nor overrides it; do not reuse a stale strategy after source facts or its digest change.

## Project Documentation Content Boundaries

This project does not add process or administrative management for the sake of documentation completeness.

- Unless the user explicitly asks and provides verifiable evidence, do not add approvals, reporting, meetings, scheduling, personnel governance, release governance, commit management, business KPIs/SLOs, or similar content.
- Do not create documents, sections, placeholders, or "to be confirmed" items for those topics.
- Existing and verified development, test, build, and deployment commands remain recorded in their own authoritative documents; this block does not change product, architecture, or engineering facts.
<!-- write-project-docs:document-navigation:end -->
