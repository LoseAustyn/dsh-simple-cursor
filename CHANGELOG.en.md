# Changelog

All notable user-visible changes to `dsh-simple-cursor`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
`package.json`. Agent-facing workflow changes are listed too when they affect
how the project is developed.

[简体中文](CHANGELOG.md)

## [Unreleased]

### Added

- Bilingual documentation: added `README.en.md` and `CHANGELOG.en.md`, cross-linked with the Chinese editions, and included `README.en.md` in the package `files` list.
- Contributor and agent documentation: `AGENTS.md`, `tests/AGENTS.md`, `.agents/skills/simple-cursor-{change,verify,release}` workflows, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/SECURITY.md`, and 7 architecture decision records under `docs/decisions/`.
- Added `check:pack` (`npm pack --dry-run`) to `npm run check`, along with `.editorconfig` and a GitHub Actions CI workflow running the same gate.
- Expanded subscription usage tests to cover `403` responses during token exchange and `401`/`403` `INVALID_CREDENTIAL` mapping on `DashboardService` calls.

### Changed

- Rewrote all project docs, `AGENTS.md` guides, ADRs, and `.agents/skills/` workflows for natural phrasing and consistent terminology, and replaced hardcoded local checkout paths with portable placeholders.
- Clarified API key source precedence in `README.md` (distinguishing plugin code from DSH's `credentials` provider layers) and updated local installation and HMR reload instructions.
- Scoped `npm test` discovery to `tests/*.test.mjs` so helper modules are never executed as test suites.
- Read the `usage.js` `user-agent` version dynamically from `package.json` instead of hardcoding `0.2`, guarded by a version-drift unit test.

### Notes

- Runtime behavior for model streaming, tool round-trips, credential storage, and the Settings UI is unchanged.
- Live Cursor requests, Settings UI interactions, and real subscription usage numbers still require manual verification with a Cursor account; see `docs/DEVELOPMENT.md` for the checklist.
