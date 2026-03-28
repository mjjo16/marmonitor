# Contributing to marmonitor

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

```bash
git clone https://github.com/mjjo16/marmonitor.git
cd marmonitor
npm install
npm run build
```

### Prerequisites

- Node.js >= 18
- macOS or Linux
- tmux (optional, for integration features)

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm run dev` | Watch mode (`tsc --watch`) |
| `npm run lint` | Run Biome linter on `src/` and `tests/` |
| `npm test` | Run all tests (Node.js native test runner) |
| `node bin/marmonitor.js status` | Run locally without global install |

## Code Style

- **Formatter/Linter**: [Biome](https://biomejs.dev/) with recommended rules
- **Quotes**: Double quotes
- **Semicolons**: Always
- **Indent**: 2 spaces
- **Line width**: 100 characters
- **Naming**: camelCase for functions/variables, PascalCase for types

Run `npm run lint` before submitting. The CI will check this automatically.

## Project Structure

```
src/
├── cli.ts        CLI entry point (commander)
├── scanner.ts    AI process detection and session enrichment
├── output.ts     Terminal output formatting (text, JSON, statusline)
├── utils.ts      Pure utility functions (sorting, formatting, paths)
├── config.ts     Configuration loader (XDG + fallback)
├── guard.ts      Claude hook evaluation (allow/block)
├── tmux.ts       tmux pane discovery and navigation
├── banner.ts     Terminal banner rendering
├── types.ts      TypeScript type definitions
└── version.ts    Single version source
```

## Writing Tests

- Place tests in `tests/` as `.test.mjs` files
- Use Node.js native test runner (`node:test` + `node:assert`)
- Run a single test: `node --test tests/utils.test.mjs`
- Aim to cover new logic with unit tests before submitting

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run the full check: `npm run lint && npm run build && npm test`
5. Commit with a clear message describing **what** and **why**
6. Open a Pull Request against `main`

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Fill out the PR template completely
- Include test coverage for new functionality
- Update README if the change is user-facing

## Adding a New AI Agent

marmonitor detects AI agents via process signatures. To add support for a new agent:

1. Add the agent to `config.ts` defaults under `agents`
2. Add process name matching in `scanner.ts` (`matchAgent`)
3. Add session enrichment logic if the agent stores local data
4. Add an agent color in `output.ts` (`agentLabel`)
5. Add tests for the new detection logic

## Reporting Bugs

Use the [bug report template](https://github.com/mjjo16/marmonitor/issues/new?template=bug_report.md). Include your OS, Node version, terminal, and which AI agents were running.

## Questions?

Open a [discussion](https://github.com/mjjo16/marmonitor/discussions) or file an issue. We're happy to help!
