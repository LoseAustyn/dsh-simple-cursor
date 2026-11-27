# Changelog

All notable user-visible changes to `dsh-simple-cursor`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
`package.json`. Agent-facing workflow changes are listed too when they affect
how the project is developed.

[简体中文](CHANGELOG.md)

## [1.0.0] - 2026-11-27

### Added

- Bilingual documentation: added `README.en.md` and `CHANGELOG.en.md`, cross-linked with the Chinese editions, and included `README.en.md` in the package `files` list.
- Contributor and agent documentation: `AGENTS.md`, `tests/AGENTS.md`, `.agents/skills/simple-cursor-{change,verify,release}` workflows, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/SECURITY.md`, and 7 architecture decision records under `docs/decisions/`.
- Added `check:pack` (`npm pack --dry-run`) to `npm run check`, along with `.editorconfig` and a GitHub Actions CI workflow (with commit-SHA-pinned actions and `npm ci --ignore-scripts`).
- Expanded test coverage for `403` token exchange and `401`/`403` `DashboardService` mapping, usage deduplication and refresh cooldowns, bridge lifecycle bounds and signal aborts, `cwd` path validation, error message redaction, and React client unmount/race-condition handling.

### Changed

- **Security & resource hardening**:
  - `sdk.js` passes an in-memory `LocalAgentStore` and `fs: emptyFs()` when creating local Cursor agents, eliminating SQLite persistence and adding client-side defense-in-depth against host file/shell executors and git status leakage; `dispose()` cleans up per-agent `agent-transcripts` directories by `agentId`.
  - `bridge.js` creates and enforces `0700` permissions on the default temporary `cwd` (rejecting symlinks and mismatched owners), stores only `sha256` API key fingerprints in session slots, `encodeURIComponent`-escapes `sessionKey` segments, rejects duplicate `toolCallId`s, caps parked tools (`128`, 10-minute timeout), and expires idle/holding sessions (`15`-minute TTL) while honoring abort signals in `holding`.
  - `config.js` hardens `cwd` validation to reject symbolic links, non-owner directories, system roots, and sensitive credential directories (`~/.ssh`, `~/.dsh`, `~/.cursor`, `~/.config`, etc.).
  - `queue.js` enforces a bounded queue limit (`10,000` items) that fails closed on overflow; `errors.js`, `adapter.js`, `bridge.js`, and `index.js` sanitize upstream errors with `sanitizeErrorMessage` and hide unexpected internal error details.
  - `usage.js`, `index.js`, and `client.js` deduplicate concurrent usage lookups, propagate `AbortSignal`s, enforce a 3-second server-side cooldown on `?refresh=1` (`429` + `Retry-After`), abort in-flight usage fetches on unmount, and discard stale responses; `index.js` logs a startup warning if `CURSOR_BACKEND_URL` is set.
  - Updated `.gitignore` for `.env` and private key files, and documented `@cursor/sdk`'s proprietary license, native binaries, telemetry, and residual directory cleanup in `README.en.md` and `docs/SECURITY.md`.
- Rewrote all project docs, `AGENTS.md` guides, ADRs, and `.agents/skills/` workflows for natural phrasing and consistent terminology, and replaced hardcoded local checkout paths with portable placeholders.
- Clarified API key source precedence in `README.en.md` (distinguishing plugin code from DSH's `credentials` provider layers) and updated local installation and HMR reload instructions.
- Scoped `npm test` discovery to `tests/*.test.mjs` so helper modules are never executed as test suites.
- Read the `usage.js` `user-agent` version dynamically from `package.json` instead of hardcoding `0.2`, guarded by a version-drift unit test.

### Notes

- Live Cursor requests, Settings UI interactions, and real subscription usage numbers still require manual verification with a Cursor account; see `docs/DEVELOPMENT.md` for the checklist.
