# Session Replay

中文说明：见 [README.zh-CN.md](./README.zh-CN.md)

Session Replay is a plugin for Hermes Dashboard that turns a raw agent session into a readable, replayable, and shareable execution view.

## What it does

Session Replay helps you:

- review a full agent session from request to final answer
- inspect tool calls, retries, errors, and long-running steps
- replay a session in a clearer narrative format than raw logs
- export a standalone HTML replay for sharing and review
- understand how Hermes completed a real task inside Dashboard

## Highlights

- Session Replay tab inside Hermes Dashboard
- session picker with search and manual session id input
- timeline filters for errors, tool calls, file changes, retries, and long-running steps
- structured replay timeline derived from session messages
- detail panel for each step with raw JSON view
- play / pause replay controls
- export to JSON replay
- export to standalone HTML replay

## Screenshots

Main replay view:

![Session Replay main view](./screenshots/replay.png)

Replay graph view:

![Session Replay graph view](./screenshots/replay-graph.png)

## Internal integration

Session Replay is intended to run inside the same Hermes Dashboard environment.

Typical usage:

1. place this repository at `~/.hermes/plugins/session-replay/`
2. start Hermes Dashboard
3. let Dashboard load the plugin automatically
4. open the `Session Replay` tab in Dashboard

The plugin works through the host Dashboard's plugin routes under `/api/plugins/session-replay/...` and uses session data from the same Hermes runtime.

This repository does not describe external deployment, cross-host proxying, or remote Dashboard connection scenarios.

## Repository structure

```text
plugin.yaml
README.md
README.zh-CN.md
dashboard/
  __init__.py
  manifest.json
  parser.py
  plugin_api.py
  dist/
    index.js
    style.css

```

## Dashboard loading

Hermes Dashboard should load the plugin from:

```text
~/.hermes/plugins/session-replay/
```

Required plugin files:

- `plugin.yaml`
- `dashboard/manifest.json`
- `dashboard/plugin_api.py`
- `dashboard/dist/index.js`
- `dashboard/dist/style.css`

## Scope

This repository focuses on the Session Replay plugin itself:

- plugin manifest and packaging
- replay parsing and export logic
- Dashboard-facing UI bundle
- replay-focused presentation layer for Hermes sessions

It does not replace Hermes itself. Its role is to make existing session data easier to inspect, replay, and share inside Hermes Dashboard.

## License

This project is released under the MIT License. See [LICENSE](./LICENSE).
