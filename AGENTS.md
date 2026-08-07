# Repository Guidelines

## Project Structure & Module Organization

This repository is currently an empty Git scaffold; no application, test, or asset directories are established. For the first implementation, prefer `src/` for runtime code, `tests/` for tests that mirror `src/`, `assets/` for static media, and `docs/` for design notes. If the selected framework has a strong conventional layout, follow it and update this guide in the same pull request.

## Build, Test, and Development Commands

No package manifest, task runner, or CI workflow exists yet. A pull request introducing a toolchain must expose and document stable commands, such as package scripts or `Makefile` targets. Until then, use:

- `git status --short` to review the working tree.
- `git diff --check` to catch whitespace errors before committing.

## Coding Style & Naming Conventions

Use UTF-8 files with LF line endings and a final newline. Indent Markdown, JSON, and YAML with two spaces; let the language's configured formatter govern source code. Prefer descriptive, lower-kebab-case filenames such as `portrait-preview.ts`, unless framework conventions require otherwise. Follow language-standard naming for symbols, keep modules focused, and comment decisions or constraints rather than restating code. Add formatter and linter configuration with the first language-specific code.

## Testing Guidelines

No test framework or coverage threshold is configured. New behavior should arrive with automated tests; bug fixes should include a regression case. Place tests in `tests/` or use the framework's colocated convention, and name them consistently (for example, `portrait-preview.test.ts`). Document the canonical test command and any required fixtures when the framework is introduced. Never weaken assertions merely to obtain a passing run.

## Commit & Pull Request Guidelines

There is no commit history from which to infer a local convention. Use Conventional Commits with concise imperative subjects, such as `feat: add portrait capture flow` or `fix: handle denied camera access`. Keep each commit and pull request narrowly scoped.

Pull requests should explain the purpose and approach, list validation performed, link relevant issues, and include screenshots for visual changes. Call out new dependencies, configuration, migrations, or follow-up work explicitly.

## Security & Configuration

Never commit credentials, private media, or local environment files. Provide sanitized examples such as `.env.example`, and document every required variable without including real values.

## Project documentation navigation

Before working on a task, read the authoritative documents relevant to its
scope:

- [Project status](STATUS.md)
- [Documentation index](docs/README.md)
- [Product overview](docs/PRODUCT.md)
- [Architecture](docs/architecture.md)
- [Development guidelines](docs/development-guidelines.md)
- [Source size and responsibility rules](docs/source-size-and-responsibility-rules.md)
- [Contribution guide](CONTRIBUTING.md)

## Documentation content boundaries

This project does not need process or administrative overhead merely to
polish documentation.

- Do not add approvals, reporting, meetings, scheduling, people
  governance, release governance, commit management, business KPI/SLOs, or
  similar content unless the user explicitly asks with verifiable grounds.
- Do not create documents, sections, placeholders, or "to be confirmed"
  items for those topics.
- Existing, verified development, test, build, and deployment commands stay
  recorded in their authoritative documents; this section changes no
  product, architecture, or engineering facts.
