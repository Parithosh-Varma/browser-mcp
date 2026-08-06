<p align="center">
  <img src="extension/icon128.png" alt="browser-mcp" width="120" height="120">
</p>

<h1 align="center">browser-mcp</h1>

<p align="center">
  <b>Your AI assistant, driving your real browser.</b><br>
  An MCP server that gives AI agents mouse-and-keyboard control over a live Chrome session.
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?style=flat-square" alt="Node.js version"></a>
  <a href="https://github.com/modelcontextprotocol"><img src="https://img.shields.io/badge/MCP-SDK%20v1.0-3f51b5?style=flat-square" alt="MCP SDK"></a>
  <a href="https://github.com/Parithosh-Varma/browser-mcp/blob/main/README.md"><img src="https://img.shields.io/badge/Chrome-MV3%20extension-4285F4?style=flat-square" alt="Chrome Extension"></a>
  <a href="https://github.com/Parithosh-Varma/browser-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

<p align="center">
  [Quick start](#quick-start) · [Tools](#tools) · [Architecture](#architecture) · [Config](#configuration) · [Testing](#testing)
</p>

**browser-mcp** is a [Model Context Protocol](https://modelcontextprotocol.io) server that extends any MCP-capable client — Claude, opencode, and friends — with full control over a real Google Chrome window. Through a tiny Chrome extension, the agent navigates pages, clicks, types, screenshots, and inspects the live DOM of a session that already has your logins, cookies, and extensions loaded.

## Quick start

```bash
npm install          # 1. install dependencies
npm start            # 2. launch the MCP server (WebSocket bridge on ws://127.0.0.1:9333)
```

Then load the extension:

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder from this repo.
3. Point your MCP client at the server:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/browser-mcp/server.js"]
    }
  }
}
```

That's it. The extension auto-connects to the bridge — no headless browser, no driver process, no screenshots-of-a-screenshot. Your AI operates the very Chrome window on your desk.

## Tools

| Tool | Does what |
|---|---|
| `browser_navigate` | Open a URL in the controlled tab, returns the page snapshot |
| `browser_snapshot` | Accessibility tree of the page, every element tagged with a `ref` |
| `browser_click` | Click an element by `ref` |
| `browser_type` | Type into a textbox / textarea, optionally press Enter |
| `browser_select_option` | Pick values from a dropdown |
| `browser_press_key` | Send keys: `Enter`, `Escape`, `ArrowDown`, `Tab`, `Meta+K`, … |
| `browser_hover` | Hover an element (reveal hover menus) |
| `browser_wait` | Pause N seconds for transitions and animations |
| `browser_back` / `browser_forward` | History navigation |
| `browser_screenshot` | Grab a PNG of the page |
| `browser_get_console_logs` | Console messages and page errors since the last call |
| `browser_close` | Close the controlled tab and detach |

Interaction tools take a `ref` from the latest `browser_snapshot` — so a typical agent loop is: **snapshot → act → snapshot → act**, exactly like a human looking at the page.

## How it works

```
                 stdio (JSON-RPC)               WebSocket 127.0.0.1:9333
  MCP client   ─────────────────▶  server.js  ─────────────────────────▶  Chrome
  (Claude,     ◀─────────────────  MCP tools    ◀────────────────────────  extension
   opencode…)       results           │ bridge                              │
                                     └──────────── 1. CDP (chrome.debugger) ─┘
                                                  2. accessibility snapshot
```

Three moving parts, one goal:

1. **`server.js`** — the MCP server. Exposes the 13 tools over stdio to any MCP client and runs an embedded WebSocket bridge for talking to the extension.
2. **The bridge** — a localhost-only listener on `127.0.0.1:9333` that multiplexes requests/responses, with per-call timeouts and automatic reconnection.
3. **The extension** (`extension/`) — an MV3 service worker connected to the bridge. It drives the active tab over the Chrome DevTools Protocol (`chrome.debugger`), renders accessibility snapshots, and reports console output back.

Because the browser machinery lives entirely in the extension, the MCP surface stays clean and standard — and because the extension keeps your real session, the agent gets your real state.

## Features

- **Controls the browser session you're already logged into** — cookies, extensions, and multi-account setups just work.
- **Compact accessibility snapshots** — role, name, value, checked-state, and a stable `ref` for every interactive element.
- **full console insight** — `browser_get_console_logs` surfaces `console.log`, warnings, and page errors, which is a huge debugging superpower.
- **Multi-display aware** — on macOS the server auto-detects your displays and targets your chosen window position (usable on Linux/Windows too, just with primary-display default).
- **Zero browser-driver setup** — no Playwright binary downloads or `npx playwright install` to run the server; Playwright is used only in the test harness.
- **Standards-first** — built on the official MCP TypeScript SDK with Zod-validated inputs.

## Configuration

Flags for `server.js`:

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `9333` | WebSocket bridge port (must match the extension's endpoint) |
| `--display <n>` | `1` | Physical display to target (1-based, prefers secondary displays on macOS) |
| `--debug` | off | Verbose diagnostics on stderr |

```bash
node server.js --port 9333 --display 2 --debug
```

Debug mode prints bridge status, connection events, and per-tool diagnostics to stderr; JSON-RPC traffic flows on stdout.

## Requirements

| Component | Requirement |
|---|---|
| Node.js | ≥ 18 |
| Browser | Google Chrome / Chromium (MV3 extension support) |
| OS | macOS fully supported (auto multi-display targeting); others fall back to the primary display |
| MCP client | Any host running external MCP servers over stdio |

## Testing

```bash
node test-client.mjs   # scripted stdio client exercising the full tool flow
node e2e.mjs            # Playwright-launched Chrome with the extension pre-loaded
```

## Project structure

```
browser-mcp/
├── server.js           # MCP server, tool definitions, WebSocket bridge
├── extension/          # Chrome MV3 extension (CDP-based tab automation)
│   ├── manifest.json   # extension manifest (permissions, service worker)
│   ├── background.js   # CDP attach, snapshot rendering, tool execution
│   ├── popup.html/.js  # status popup
│   ├── icons/          # 16/32/48/128 px
│   └── …
├── test-client.mjs     # MCP stdio smoke test
├── e2e.mjs             # end-to-end test with Playwright
├── package.json
└── README.md
```

## License

MIT © 2026 Parithosh Varma