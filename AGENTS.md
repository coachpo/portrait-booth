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

## 项目文档导航

执行相关任务前，根据任务范围读取以下权威文档：

- [项目状态](STATUS.md)
- [文档索引](docs/README.md)
- [产品说明](docs/product.md)
- [架构说明](docs/架构说明.md)
- [开发规范](docs/开发规范.md)
- [源代码规模与职责规则](docs/源代码规模与职责规则.md)
- [贡献指南](CONTRIBUTING.md)

## 项目文档内容边界

本项目不需要为完善文档而引入流程或行政管理。

- 除非用户明确要求并提供可验证依据，不新增审批、汇报、会议、排期、人员治理、发布治理、提交管理、业务 KPI/SLO 或类似内容。
- 不为上述主题创建文档、章节、占位符或“待确认”项。
- 已有且经验证的开发、测试、构建和部署命令仍按对应权威文档记录；本区块不改变产品、架构或工程事实。
