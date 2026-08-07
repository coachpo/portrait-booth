# Contribution guide

## Current development status

The repository is a monorepo with `frontend/` (Vite + React + TypeScript),
`backend/` (FastAPI + SQLite + local disk storage), and `templates/`
(versioned template data).

Of the "stable commands" below, all but `npm run dev`, `uv run uvicorn`,
`docker compose`, and the Playwright end-to-end tests run in CI (see
`.github/workflows/ci.yml`). End-to-end tests currently require manual
execution and are not wired into CI.

## Stable commands

```sh
# Frontend (working directory frontend/)
npm install                # install dependencies
npm run dev                # dev server (port 5173, /api proxied to 8000)
npm run build              # type check + production build to dist/
npm test                   # Vitest unit tests
npm run test:e2e           # Playwright end-to-end (first run needs npx playwright install chromium; backend needs uv sync --extra dev first)
npm run lint               # ESLint
npm run format:check       # Prettier check

# Backend (working directory backend/, using uv)
uv sync --extra dev        # install dependencies (including dev)
uv run uvicorn app.main:app --reload   # dev server (port 8000)
uv run pytest              # pytest tests
uv run ruff check .        # static checks
uv run ruff format --check .           # format check
uv run python -m app.template_tools validate   # template content gate (schema + reference integrity + contentHash)
uv run python -m app.template_tools report     # template review status and days left to SLA
uv run python -m app.template_tools rehash     # write back contentHash after template content changes

# Full stack (repository root)
docker compose up --build  # build and start frontend/backend containers
```

## Currently available checks

```sh
git status --short
git diff --check
```

## Development workflow

1. Read the [product overview](docs/PRODUCT.md), [project status](STATUS.md),
   [architecture](docs/architecture.md), and [development guidelines](docs/development-guidelines.md).
2. Confirm the requirement scope, module responsibilities, data boundaries,
   and acceptance conditions before making changes.
3. Use the minimal implementation that satisfies the current requirements;
   add automated tests for new behavior and regression cases for bug fixes.
4. Run all applicable tests, static checks, format checks, and builds provided
   by the current toolchain.
5. Sync the single authoritative documents and verify the working tree
   contains only this change.

Project-specific technical rules live in the [development guidelines](docs/development-guidelines.md); component responsibilities and dependency
orientation in the [architecture](docs/architecture.md); long files and
responsibility splitting in the [source size and responsibility rules](docs/source-size-and-responsibility-rules.md).

## General design principles

Given confirmed functional scope, architectural boundaries, quality
attributes, security, compatibility, and runtime constraints, choose a
design in the following order:

1. Designs, patterns, interfaces, or components already in the project that
   are proven and still applicable;
2. applicable formal standards, standard protocols, and official platform or
   framework recommendations;
3. mature industry solutions widely adopted in similar scenarios, actively
   maintained, and backed by reliable practice evidence;
4. only when none of the above satisfies a verified constraint, a minimal
   custom design that meets the current requirements.

"Widely used" is only a candidate signal, not a sufficient reason to adopt.
Before adopting, check against risk: requirement fit, security and
compatibility, primary failure modes, and maintenance and migration cost;
never introduce capabilities, abstractions, or dependencies the current
scope does not need just to follow convention.

Important design choices touching architecture boundaries, dependency
direction, data responsibility, security boundaries, or long-lived
dependencies should record the applicable rationale, key trade-offs, and
verification method in the design result. When adopting a custom design,
also state the verified constraints that make mature solutions inapplicable.
For high-risk, evidence-poor choices, first define observable success,
failure, and exit conditions, then run the smallest reversible verification
permitted by current permissions; never write unaccepted or unimplemented
candidates into the current architecture as fact.

## General implementation principles

Given the functional scope, architecture boundaries, correctness,
security, and verifiability, choose an implementation in the following
order:

1. Implementations already in the project;
2. the language standard library;
3. native platform capabilities;
4. dependencies already installed and fitting the current scenario;
5. third-party libraries that fit the environment, are mature, active, and
   widely used;
6. a minimal custom implementation that satisfies the current requirements.

Search for existing implementations before adding code. Do not introduce
large dependencies for small features; do not create abstraction,
extension, or compatibility layers for hypothetical future needs; keep
custom implementations local, simple, and testable.

Implementations must follow the architecture facts in [`docs/architecture.md`](docs/architecture.md), the project/technical rules in
[`docs/development-guidelines.md`](docs/development-guidelines.md), and the
uniform size and responsibility rules in
[`docs/source-size-and-responsibility-rules.md`](docs/source-size-and-responsibility-rules.md).

## Definition of done

A change is done only when all of the following hold:

- The implementation matches the confirmed functional scope and acceptance
  conditions;
- important design choices verified the applicability of mature solutions;
  when a custom solution was adopted, the inapplicable constraints, key
  trade-offs, and verification method are recorded;
- existing architecture boundaries and dependency directions are preserved,
  with no unrelated responsibilities or drive-by changes;
- the applicable project/technical development guidelines are met;
- the relevant tests, static checks, format checks, and build verification
  pass;
- single authoritative documents, machine contracts, and verification are
  synced per the development guidelines;
- no keys, credentials, personal data, generated artifacts, or unrelated
  files are committed;
- the source size and responsibility rules check is done and any long files
  needing explanation are reported.
