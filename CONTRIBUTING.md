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
├── cli.ts                  CLI entry point (commander)
├── types.ts                Shared type definitions
├── version.ts              Single version source
├── process-safety.ts       Process error handling
├── config/index.ts         Configuration loader (XDG + fallback)
├── scanner/
│   ├── index.ts            Main scanner orchestrator + public API
│   ├── cache.ts            Shared cache instances (BoundedMap)
│   ├── claude.ts           Claude Code session parsing
│   ├── codex.ts            Codex session parsing
│   ├── gemini.ts           Gemini session parsing
│   ├── process.ts          OS process detection utilities
│   ├── status.ts           Activity status determination
│   ├── group.ts            Parent-child process grouping
│   └── bounded-map.ts      Size-limited LRU cache
├── output/
│   ├── index.ts            Terminal output formatting
│   └── utils.ts            Pure utility functions
├── guard/index.ts          Claude hook evaluation (allow/block)
├── tmux/index.ts           tmux pane discovery and navigation
└── banner/index.ts         Terminal banner rendering
```

## Writing Tests

- Place tests in `tests/` as `.test.mjs` files
- Use Node.js native test runner (`node:test` + `node:assert`)
- Run a single test: `node --test tests/utils.test.mjs`
- Aim to cover new logic with unit tests before submitting

## Branch Naming

Use `feature/{issue-number}` format:

```
feature/72      ← issue #72
feature/63      ← issue #63
```

Do not use descriptive branch names like `feature/add-gemini-tracking`.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body>
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `perf` | Performance improvement |
| `chore` | Build, config, dependency updates |

### Examples

```
feat: add gemini phase decay tracking
fix: stalled sessions with permission phase excluded from statusline
refactor: split scanner.ts into feature-based modules
test: add BoundedMap eviction tests
docs: add phase icon legend to help output
perf: replace execSync with async execFile
chore: remove Python legacy files
```

### Rules

- Use imperative mood ("add", not "added" or "adds")
- Keep the first line under 72 characters
- Reference issue numbers in the body: `Resolve #72`
- Do not include secrets, keys, or credentials in messages

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/{issue-number}`
3. Make your changes
4. Run the full check: `npm run lint && npm run build && npm test`
5. Commit following the conventions above
6. Open a Pull Request against `main`

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Fill out the PR template completely
- Include test coverage for new functionality
- Update README if the change is user-facing
- PR title format: `Feature/{issue-number} short description`

## Adding a New AI Agent

marmonitor detects AI agents via process signatures. To add support for a new agent:

1. Add the agent to `config/index.ts` defaults under `agents`
2. Add process name matching in `scanner/process.ts` (`detectAgentFromProcessSignature`)
3. Add a new parser file `scanner/{agent}.ts` for session enrichment
4. Add an agent color in `output/index.ts` (`agentLabel`)
5. Wire up the new parser in `scanner/index.ts` (`scanAgents`)
6. Add tests for the new detection and parsing logic

## Reporting Bugs

Use the [bug report template](https://github.com/mjjo16/marmonitor/issues/new?template=bug_report.md). Include your OS, Node version, terminal, and which AI agents were running.

## Questions?

Open a [discussion](https://github.com/mjjo16/marmonitor/discussions) or file an issue. We're happy to help!
