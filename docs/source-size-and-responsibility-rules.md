# Source size and responsibility rules

## Purpose

This policy constrains the responsibility boundaries and maintainable
size of hand-written source code, helping developers and coding agents keep
the existing architecture, avoid responsibility sprawl, and proactively
review structure before files keep growing.

Line counts are review signals, not quality verdicts. Any split must
improve responsibility, dependency direction, testability, or change
isolation; never break cohesion just to satisfy a number.

This policy's line thresholds count effective code lines: blank lines and
comment-only lines are excluded; lines containing code count even with a
trailing comment.

## Applicability

This policy applies to ordinary hand-written source files carrying
business behavior, interaction behavior, state management, orchestration,
adaptation, data access, or infrastructure behavior.

The following do not directly apply the ordinary behavior-file
thresholds but must stay clear, reviewable, and compliant with the project
architecture:

- Auto-generated code reproducible by a deterministic process;
- database migrations and indivisible historical evolution records;
- schemas, protocols, catalogs, mapping tables, and other files that are
  primarily declarative data;
- third-party or vendored code;
- test snapshots, fixed fixtures, and large test data;
- integration tests kept cohesive by a full narrative or end-to-end flow.

This policy must not be evaded by disguising behavior code as
configuration, macros, callbacks, generated code, or data tables.

## Size review signals

- At about 240 lines, check the file's main responsibility, dependency
  direction, and natural split boundaries early, to avoid passive growth
  under later requirements.
- Above 300 lines, an ordinary hand-written behavior file needs structured
  justification in the change note: the file's single main responsibility,
  external interface, main dependencies, test boundary, and why splitting
  now would lower cohesion or add unnecessary coupling.
- When a new ordinary hand-written behavior file is expected to exceed 500
  lines, form an explicit project-level decision before implementation and
  record the verified structural exception in `docs/architecture.md`.
  Never write the long file first and substitute post-hoc notes for
  up-front judgment.
- At about 50 lines, a function or method should be checked for mixed
  stages, abstraction layers, error-handling strategies, or side effects.
  Keeping a longer function requires explaining its continuity and testable
  boundary.

These numbers are not automatic split lines. The project may keep
exceptions based on verifiable structural reasons, but exceptions must not
rewrite this general policy.

## Responsibility and splitting principles

- Every file should have one clearly expressible main responsibility and
  primary reason to change.
- Split along domain boundaries, module boundaries, state lifecycles,
  input/output boundaries, or side-effect boundaries.
- Entry points, composition roots, and route layers stay thin - mainly
  assembly, dispatch, and boundary conversion; no uniform line ceiling is
  imposed on them detached from project facts.
- New responsibilities go into an existing correct module or a new module
  with a clear interface; convenient access is not a placement rationale.
- Extraction should reduce cognitive load and keep or improve dependency
  direction, naming, tests, and error handling.

The following mechanical splits are forbidden:

- cutting by line count into `part1`, `part2`, or sibling files without
  clear meaning;
- pooling unrelated logic into generic `utils`, `helpers`, or "common"
  modules;
- adding pass-through wrapper layers, proxy layers, or interfaces without
  business meaning;
- hiding complexity through nested callbacks, macros, configuration, or
  generation steps;
- moving code without forming a new responsibility or test boundary.

## Legacy large files

- Existing large files do not automatically become refactoring targets of
  unrelated changes just because of the number.
- When modifying a legacy large file, do not keep adding new independent
  responsibilities.
- If a safe, natural, verifiable split boundary exists near this change,
  extract it first and run the applicable verification.
- If splitting would widen scope, change behavior, or lack verification
  conditions, keep the change local and explain in the change note why it
  was not split; never mask the current requirement with a large drive-by
  refactor.

## Coding agent execution requirements

Before starting to code:

1. Read `docs/architecture.md`, `docs/development-guidelines.md`, and this
   policy;
2. confirm the target module, allowed dependency direction, and existing
   implementation;
3. check the current size and responsibility of the files to be modified or
   added.

While coding:

1. Keep checking whether independent responsibilities, architecture-boundary
   crossings, or duplicated capabilities were added;
2. split at natural boundaries as they appear, rather than mechanically
   after the file is complete;
3. keep entry and composition code thin, with business rules in their own
   modules.

Before finishing:

1. Run the project's applicable tests, static checks, and build
   verification;
2. list ordinary hand-written behavior files above 300 lines added or
   modified this round; if none, say so explicitly;
3. explain each listed file's responsibility basis; new files above 500
   lines must also point to the structural exception recorded in advance in
   `docs/architecture.md`;
4. confirm this policy was not evaded via mechanical splits, meaningless
   abstractions, or hidden complexity.
