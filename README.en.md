# Simple Cursor（简单 Cursor）

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![Supported DSH versions: 0.2.2-rc.4+](https://img.shields.io/badge/DSH-0.2.2--rc.4%2B-4d6bfe)](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)

[简体中文](README.md)

> Third-party community plugin. Not affiliated with, endorsed by, or maintained by Cursor.

A Cursor model provider plugin for DSH. It connects your Cursor subscription to DSH through the official `@cursor/sdk`, adding a `Cursor` provider to the model selector and billing usage to your own Cursor account:

- **Account catalog & context variants** — Pulls available models from your Cursor account and expands multi-context models into selectable entries (such as `300K` and `1M`), reporting the exact token capacity to DSH for automatic context compaction.
- **DSH-managed tool execution** — Exposes only DSH-supplied custom tools to Cursor while keeping Cursor's built-in file, terminal, and web tools disabled, preventing two runtimes from modifying your workspace or bypassing DSH approval policies.
- **Managed credentials & usage view** — Stores your API key in DSH's credentials service from **More → Settings → Cursor** (never in plugin config files) and displays your active plan, billing cycle, usage meters, and reset time on the same page.

## Installation

Because this plugin depends on `@cursor/sdk` and `@deepseek-ai/schemastery`, install its dependencies in the plugin directory first:

```sh
cd /path/to/simple-cursor
npm install
```

Then add the local directory to DSH using either method:

- **DSH Web UI**: Go to **Plugins → Add plugin** and select the `simple-cursor` folder. It activates immediately without changing your default model.
- **Command line**: Run the CLI command below (which installs dependencies and registers the bundle in the profile), then restart DSH once to load it:
  ```sh
  dsh plugin --profile web add /path/to/simple-cursor
  ```

## API Key & Usage

### Saving an API Key

1. Generate an API key (personal key or team service-account key) at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).
2. Open **More → Settings → Cursor** in DSH Web, paste the key, and click **Save**.

The key is stored under `CURSOR_API_KEY` in DSH's `credentials` service — never in `cordis.patch.yml` and never sent back to the browser. Updating the key takes effect on the next model request without restarting DSH.

Plugin code never reads environment variables, profile config fields, or `~/.cursor/sdk/auth.json` directly. If your host environment defines `CURSOR_API_KEY` in the process environment or a `.env` file, DSH's own local credential provider may resolve it according to its layer precedence (managed store > environment > `.env`) and report that source (for example, `env`) in the status line. Clicking **Clear** deletes the entry from the managed store.

### Viewing Subscription Usage

Once a key is configured, **More → Settings → Cursor** displays your subscription usage: plan name, billing period, total usage, Auto + Composer usage, API model usage, usage pool, on-demand spend, and next reset time. The host exchanges the saved key for a short-lived token in the background and caches snapshots for 30 seconds; click **Refresh** to bypass the cache.

### Optional Plugin Configuration

Advanced settings can be placed under `config` on the `id: simple-cursor` entry in your profile's `cordis.patch.yml`:

- `cwd` — Existing absolute directory path where local Cursor agents keep runtime state. Defaults to `dsh-simple-cursor` under the OS temporary directory.
- `contextWindow` — Fallback context window (in tokens) used only when a model's catalog entry does not advertise a `context` parameter. Defaults to `128000`.

## Features

### Model Catalog & Context Windows

Once loaded, **Cursor** appears in the DSH model selector. The adapter fetches your account's model catalog using the saved key and caches successful responses for 60 seconds:

- **Selectable context sizes**: Models that advertise a `context` parameter are expanded into separate entries (for example, `Claude Opus 5.5 · 1M` for the catalog default and `Claude Opus 5.5 · 300K` for an explicit variant). Selecting an entry forwards the full variant parameters (including `context` and `maxMode` when required) to `@cursor/sdk` and reports the matching capacity to DSH.
- **Reasoning effort**: Models that expose a reasoning parameter integrate directly with DSH's reasoning-effort selector.
- **Offline fallback**: If the live catalog cannot be fetched yet, the selector falls back to `Composer 2.5` and `Auto` entries and validates credentials when a conversation starts.

### Session Continuity & Tool Round-Trips

- **One local agent per session**: Each DSH conversation keeps a dedicated local Cursor agent in memory. When the model calls a tool, the Cursor run pauses while DSH executes the tool and feeds the result back into the same run until the turn finishes.
- **Transcript fingerprinting**: Follow-up turns with an unchanged prefix send only the newly appended messages. After context compaction, rollback, or any history rewrite, the plugin discards the old agent and starts a fresh one with the full updated transcript.
- **Isolated auxiliary calls**: Background requests carrying a `purpose` (such as session title generation or context compaction) run on separate short-lived agents so they never pollute the active conversation.

## Limitations

- Runs local agents on your machine; Cursor cloud VMs are not used.
- Cursor's agent API does not accept `temperature`, `maxTokens`, or `stop`. Regular chat turns that specify any of these fail explicitly, whereas DSH-generated auxiliary requests (titles, compaction) run with Cursor's defaults instead of failing.
- Long-context or `Max Mode` variants may consume more quota or bill at long-context rates according to Cursor's pricing rules.
- Dedicated SDK system prompts require special account entitlement, so one-shot system prompts are prepended to the user message body instead.
- During multi-step tool round-trips, token usage is reported on the final response when the underlying Cursor run completes.
- Image inputs require DSH's `attachments` service; requests containing images fail cleanly if that service is absent.
- Intended strictly for personal use with your own DSH instance in compliance with Cursor's Terms of Service.

## Security

- **Credential isolation**: The API key is read exclusively on the host via `ctx.credentials.resolve('CURSOR_API_KEY')`. The browser can save or clear it, but never receives the raw key or short-lived access tokens.
- **Authenticated usage endpoint**: `/api/dsh-simple-cursor/usage` is registered on DSH `connection`'s authenticated `/api` transport, inheriting host origin checks, cookie authentication, and owner-peer authorization, and returns only normalized percentages and quota fields.
- **Locked tool boundary**: Local agents are created with `tools: ['mcp']` and `settingSources: []`, keeping Cursor's built-in tools and ambient user/project MCP servers turned off.

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model and security rules.

## Development & Verification

| Path | Purpose |
|---|---|
| `index.js` | Node host entry: config validation, `cursor` adapter registration, usage route, image loading, disposal |
| `adapter.js` / `catalog.js` | `LlmAdapter` implementation, 60s model catalog cache, context & reasoning variant selection, key lookup |
| `bridge.js` / `transcript.js` | Session-scoped local agent lifecycle, transcript fingerprinting, prompt rendering, tool parking & resumption |
| `chunks.js` / `queue.js` / `errors.js` | DSH stream chunk assembly, ordered event queue, SDK/transport error mapping |
| `sdk.js` / `config.js` / `schema.js` | Lazy `@cursor/sdk` wrapper, local agent options, config validation & Cordis schema |
| `usage.js` | Short-lived token exchange, Cursor usage RPCs, response normalization, and 30s in-memory cache |
| `client.js` | Browser entry: **More → Settings → Cursor** page, key save/clear controls, and usage display |
| `tests/*.test.mjs` | Offline `node:test` suites covering catalog, bridge, transcript, host route, usage, and client UI |

Run the check suite (also used in CI):

```sh
npm install      # first-time install for @cursor/sdk, schemastery, and peer dependencies
npm run check    # syntax check + unit tests + npm pack manifest check
npm test         # unit tests only (offline; never contacts Cursor)
```

Reloading changes locally:

- **Client (`client.js`, `locale/*.json`, `icon.svg`)**: Refresh the browser page (hard-refresh if browser caching holds onto old locale copy or icons).
- **Host (`index.js`, `adapter.js`, `bridge.js`, etc.)**: Because the default Web profile's HMR does not watch external linked source directories on save, trigger a bundle recomposition by removing and reinstalling the same directory (`remove_bundle` → `install_bundle`), or restart DSH. Calling `install_bundle` while the package is already installed returns `already-installed`, so remove it first.

See [docs/](docs/) ([ARCHITECTURE.md](docs/ARCHITECTURE.md), [DEVELOPMENT.md](docs/DEVELOPMENT.md), [decisions/](docs/decisions/)) for architecture notes, debugging tips, and ADRs, [AGENTS.md](AGENTS.md) for agent-oriented contributor guidelines, and [CHANGELOG.en.md](CHANGELOG.en.md) for release history.
