# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in marmonitor, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **mjjo16@gmail.com** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

You will receive a response within 72 hours acknowledging the report.

## Security Considerations

marmonitor is a local monitoring tool that interacts with system processes. Key security-relevant features:

### Process Termination (`clean --kill`)

The `clean --kill` command can terminate processes via `SIGTERM`. This feature:
- Only targets processes identified as unmatched AI agents
- Verifies process identity before termination
- Requires explicit `--kill` flag (not triggered by default)

### Guard / Hook Evaluation (`guard`)

The `guard` command evaluates Claude Code hook payloads. It follows a **fail-open** policy:
- Any error or malformed input results in `{"decision": "allow"}`
- This prevents marmonitor failures from blocking the user's AI agent

### Local-Only Data

marmonitor makes **zero network connections**. All data (process info, session files, tokens) is read from the local filesystem only. No telemetry, no analytics, no external API calls.

### File Access

marmonitor reads (never writes to) AI agent session files:
- `~/.claude/projects/*/sessions/*.jsonl`
- Codex session logs
- Gemini state files

It writes only to its own temp cache (`/tmp/marmonitor/`) and configuration directory.
