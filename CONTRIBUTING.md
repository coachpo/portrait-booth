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

1. Read the [product overview](docs/product.md), [project status](STATUS.md),
   [architecture](docs/architecture.md), and [Development Rules](docs/development-rules.md).
2. Confirm the requirement scope, module responsibilities, data boundaries,
   and acceptance conditions before making changes.
3. Use the minimal implementation that satisfies the current requirements;
   add automated tests for new behavior and regression cases for bug fixes.
4. Run all applicable tests, static checks, format checks, and builds provided
   by the current toolchain.
5. Sync the single authoritative documents and verify the working tree
   contains only this change.

Project-specific technical rules live in the [Development Rules](docs/development-rules.md); component responsibilities and dependency
orientation in the [architecture](docs/architecture.md); long files and
responsibility splitting in the [Source Code Size and Responsibility Rules](docs/source-code-size-and-responsibility-rules.md).

<!-- write-project-docs:derived-iteration-strategy:start -->
<!-- write-project-docs:derived-iteration-strategy:metadata {"contentSha256":"sha256:8e27c8e89b715cab27ed8ad67e552966ce89fccece1d24fc58228b9b21c1d242","schemaVersion":1,"sources":[{"normalization":"without-visible-exact-mvp-control-line-terminal-lf-v2","path":"STATUS.md","sha256":"sha256:bc7787c528973f161d41a01b5101238e4aa26daf29a0040b29083935c2bc2387"},{"path":"docs/product.md","sha256":"sha256:10ebee5808de0f6e45323fc138de1252741a2ae8f6691ec4671ddfea091def0e"},{"path":"docs/architecture.md","sha256":"sha256:1cf4b160601e911b921b7962b6544d69bc7643e23ec725d3c1ebe1a089cd7cc4"},{"path":"docs/development-rules.md","sha256":"sha256:a7768dd495255f637efcffcc3528f20d93bbb781941c03a47a4cd8011f3d6f48"}]} -->
## Current Iteration Strategy

Run a repeatable, observable local demonstration loop: deliver through the local full-stack Docker container or the two-process dev topology, bound to the reviewed templates and their official source text; before any demo or delivery run the applicable tests, static checks, format checks, and builds, and keep the create, export/stage, KEY retrieval, and delete flows walkable end to end.

Derived from (the source documents remain authoritative): [`STATUS.md`](STATUS.md), [`docs/product.md`](docs/product.md), [`docs/architecture.md`](docs/architecture.md), [`docs/development-rules.md`](docs/development-rules.md).

> This block scopes only the current iteration. It does not change the MVP fast-validation switch or weaken security, privacy, permissions, data integrity, existing compatibility commitments, or higher-priority requirements.

### Must Complete Now

- Keep the local create to export/stage to KEY retrieval to delete loop walkable with visible results, backed by the applicable pytest, Vitest, lint, format, build, and template-gate checks.
- Before any demonstration, run the template content gate (uv run python -m app.template_tools validate) so templates stay versioned, source-bound, and reviewable.
- Do not display unreviewed or inapplicable templates as submittable artifacts; keep reference_only and unsupported statuses accurate in the demo.

### Not Pursued This Iteration

- Public-retrieval abuse-resistance hardening (rate-limit dimensions, logs and metrics, streamed uploads, constant-time retrieval, CAPTCHA and KEY hardening). Basis: no release environment, external users, or public retrieval exists at this stage. Recheck: when any deployment, external user, or public retrieval appears.
- Load and stress testing, capacity planning, high availability, and production-grade observability. Basis: no performance acceptance criteria or reachable load risk at the local demonstration stage. Recheck: when throughput, concurrency, or latency acceptance criteria or real traffic appear.
- P1 print layouts and PDF, and the P2 PWA shell. Basis: recorded product non-goals for this stage with no current requirement. Recheck: when product scope or acceptance criteria change.

### Non-negotiable Boundaries

- Do not weaken implemented privacy and security boundaries while demonstrating: KEY-only retrieval, short retention, same-origin enforcement, delete/download separation, and no photos, KEYs, or credentials in logs.
- Heuristic checks may only report checked items and must never claim official approval, certification, or guaranteed acceptance.
- Existing repository checks (pytest, Vitest, lint, format, build, template content gate) must keep passing for every demonstration state.

### Re-derivation Triggers

- A deployment appears beyond the local machine, external users arrive, public retrieval is implemented, or real or non-discardable data is used.
- Throughput, concurrency, or latency acceptance criteria, or production-grade observability requirements appear.
- The Public Beta template manifest, product scope, or acceptance criteria change materially.
<!-- write-project-docs:derived-iteration-strategy:end -->

<!-- write-project-docs:shared-contributing:start -->
## General Design Principles

While satisfying the confirmed functional scope, architectural boundaries, quality attributes, security, compatibility, and runtime constraints, choose a design in this order:

1. Existing, verified, and still-applicable designs, patterns, interfaces, or components already in the project;
2. Applicable formal standards, standard protocols, and officially recommended platform or framework solutions;
3. Mature industry solutions that are widely adopted in similar scenarios, actively maintained, and backed by reliable evidence of practice;
4. Only when none of the above satisfies a verified constraint, the smallest custom design that meets the current requirement.

"Widely used" is a candidate signal, not sufficient reason to adopt. Before adopting, check requirement fit, security and compatibility, primary failure modes, and maintenance and migration cost against the risk. Do not introduce capabilities, abstractions, or dependencies outside the current scope merely to follow a convention.

For significant design choices that touch architectural boundaries, dependency direction, data ownership, security boundaries, or long-lived dependencies, record the applicable rationale, the primary trade-offs, and the verification method in the design outcome. When adopting a custom design, also state the verified constraints that make mature solutions inapplicable. When risk is high and evidence is thin, first define observable success, failure, and exit conditions, then run the smallest reversible validation your current authority allows. Do not write unaccepted or unimplemented candidates into the record as current architectural fact.

## General Implementation Principles

While satisfying functional scope, architectural boundaries, correctness, security, and verifiability, choose an implementation in this order:

1. Existing implementations in the project;
2. The language standard library;
3. Platform-native capabilities;
4. Dependencies already installed in the project that fit the current scenario;
5. Mature, actively maintained, widely used third-party libraries suited to the current environment;
6. The smallest custom implementation that meets the current requirement.

Search for an existing implementation before adding new code. Do not pull in a large dependency for a small feature; do not create abstraction, extension, or compatibility layers for hypothetical future requirements; keep custom implementations local, simple, and testable.

Implementations must comply with the project architecture facts in [`docs/architecture.md`](docs/architecture.md), the project- and technology-specific rules in [`docs/development-rules.md`](docs/development-rules.md), and the unified size and responsibility rules in [`docs/source-code-size-and-responsibility-rules.md`](docs/source-code-size-and-responsibility-rules.md).

## Definition of Done

A change is complete only when all of the following hold:

- The implementation matches the confirmed functional scope and acceptance conditions;
- Significant design choices have been checked against the applicability of mature solutions; where a custom solution was adopted, the inapplicable constraints, primary trade-offs, and verification method are recorded;
- Existing architectural boundaries and dependency direction are preserved, with no unrelated responsibilities or incidental changes added;
- Applicable project- and technology-specific development rules are satisfied;
- Relevant tests, static checks, format checks, and build verification pass;
- The single authoritative documents, machine contracts, and validation are synchronized as required by the development rules;
- No secrets, credentials, personal data, build artifacts, or unrelated files are committed;
- The source code size and responsibility rules have been applied, and any long files that need explanation are reported.
<!-- write-project-docs:shared-contributing:end -->
