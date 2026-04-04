## Summary

Resolve #33

Release `dev` into `main` as `v0.2.3`.

## Type

- [ ] `[FEAT]` New feature
- [ ] `[BUG]` Bug fix
- [ ] `[HOTFIX]` Urgent fix
- [ ] `[PERF]` Performance improvement
- [ ] `[REFACTOR]` Code restructuring
- [ ] `[DOCS]` Documentation
- [ ] `[TEST]` Test coverage
- [x] `[CICD]` CI/CD or release
- [ ] `[CHORE]` Maintenance

## Changes

- bump package version from `0.2.2` to `0.2.3`
- release the post-`v0.2.2` `dev` changes to `main`
- include completed work from:
  - `#25` Codex PID-to-thread binding registry
  - `#27` session activity log and CLI
  - `#28` Codex binding key mismatch fix
  - `#31` session continuity and activity freshness stabilization
- include merged PRs:
  - `#26` `[FEAT] #25 Codex binding registry and SQLite enrichment optimization`
  - `#29` `[FEAT] #27 Add session activity log and CLI`
  - `#30` `[BUG] #28 Fix Codex binding key mismatch in foreground paths`
  - `#32` `[BUG] #31 Stabilize session continuity and Codex activity freshness`

## Checklist

- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (all tests green)
- [ ] New features have tests
- [ ] README updated (if user-facing changes)
- [x] No hardcoded paths or environment-specific values

## Testing

- `npm run -s build`
- `npm run lint`
- `npm test`

## Risk

Medium. This is a `dev` to `main` release PR and includes multiple completed features and fixes since `v0.2.2`.
