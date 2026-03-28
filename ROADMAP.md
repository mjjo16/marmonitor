# Roadmap

> marmonitor — Standing guard over your AI coding sessions

## Current: v0.1 — Foundation

The first public release. Core monitoring and terminal integration.

- [x] AI process detection (Claude Code, Codex, Gemini CLI)
- [x] Session enrichment (tokens, phases, activity timestamps)
- [x] Multiple output modes: `status`, `watch`, `dock`, `attention`, `jump`
- [x] tmux and WezTerm statusline integration
- [x] Claude hook guard (allow/block decisions)
- [x] Configuration via `~/.config/marmonitor/settings.json`
- [ ] Release hardening (crash handler, signal safety, path discovery)
- [ ] npm publish

## Next: v0.2 — Accuracy & Polish

Improving detection accuracy and user experience.

- Session enrichment accuracy (incremental parsing, state decay)
- Codex/Gemini session data parity with Claude
- Statusline UX improvements
- Expanded test coverage

## Future: v0.3 — Security Watch

Building on the guard MVP to provide broader security monitoring.

- File change tracking correlated with AI sessions
- Dangerous command pattern detection
- Risk signal integration with output/statusline

## Later

- TUI full dashboard
- SQLite time-series storage and usage reports
- Cost estimation (when token pricing APIs are available)
- Plugin system for custom AI agents
- Multi-machine monitoring

## Non-Goals

- Cloud/SaaS — marmonitor is local-first by design
- Agent instrumentation — we observe from outside, no code changes needed
- Replacing agent-native monitoring — we complement, not compete

---

Have ideas? [Open a feature request](https://github.com/mjjo16/marmonitor/issues/new?template=feature_request.md).
