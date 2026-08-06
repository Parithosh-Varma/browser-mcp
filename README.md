# browser-mcp

A Model Context Protocol (MCP) server that lets an AI assistant control your real Chrome browser — clicking, typing, navigating, and screenshotting live pages through a lightweight Chrome extension.

Built on the official [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), no separate browser binary or Playwright driver process needed at runtime.

## How it works

```
┌────────────────────┐   stdio (JSON-RPC)   ┌───────────────────────────┐   WebSocket (127.0.0.1:9333)   ┌──────────────────────────┐
│  MCP client        │ ───────────────────▶ │  server.js (MCP server)   │ ──────────────────────────────▶ │  Chrome extension         │
│  (Claude, opencode,│                      │  └ exposes 13 tools       │                                 │  (background.js, MV3)     │
│  any MCP host)     │ ◀─────────────────── │  └ WebSocket bridge       │ ◀────────────────────────────── │  └ uses Chrome DevTools   │
└────────────────────┘                      └───────────────────────────┘                                 │    Protocol (CDP) to drive │
                                                                                                          │    a real Chrome tab      │
                                                                                                          └──────────────────────────┘
```

1. **`server.js`** is an MCP server over stdio. It exposes browser tools to any MCP client.
2. Inside the server, a WebSocket bridge listens on `127.0.0.1:9333`.
3. **The Chrome extension** (MV3, `extension/`) connects to that bridge and acts as the remote control: it drives the browser through the Chrome DevTools Protocol (`chrome.debugger` API) and reports back an accessibility-style snapshot of the page.
4. Tools are executed by passing messages over the bridge; results (snapshots, screenshots, console logs) are returned to the MCP client.

This design means the server controls the *real* Chrome window you can see — including its existing login sessions, cookies, and multi-display setup — rather than a hidden headless browser.

## Features / Tools

| Tool | Description |
|---|---|
| `browser_navigate` | Open a URL in the controlled tab, returns the page snapshot |
| `browser_snapshot` | Accessibility tree of the page with `ref` ids for every element |
| `browser_click` | Click an element by `ref` |
| `browser_type` | Type text into a textbox/textarea, optionally press Enter |
| `browser_select_option` | Select option(s) in a dropdown |
| `browser_press_key` | Press keyboard keys (Enter, Escape, ArrowDown, Tab, Meta+K, …) |
| `browser_hover` | Hover an element (hover menus) |
| `browser_wait` | Wait N seconds for page transitions/animations |
| `browser_back` / `browser_forward` | Navigate history |
| `browser_screenshot` | PNG screenshot of the current page |
| `browser_get_console_logs` | Console messages and page errors since the last call |
| `browser_close` | Close the controlled tab and detach |

## Requirements

- **Node.js ≥ 18**
- **Chrome or Chromium** (the extension uses MV3 + `chrome.debugger`)
- **macOS** for automatic multi-display targeting (optional; other platforms fall back to the primary display)

## Installation

```bash
npm install
```

## Setup

### 1. Load the extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this repo
4. Pin the **browser-mcp controller** extension (optional)

### 2. Start the server

```bash
npm start
```

The server prints status to stderr:

```
[browser-mcp] extension bridge listening on ws://127.0.0.1:9333
[browser-mcp] extension connected
[browser-mcp] targeting display 1 of 2 at x=1920 y=0 1920x1080
```

### 3. Connect an MCP client

Configure your MCP client to launch the server, e.g. for Claude Code / opencode:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/browser-mcp/server.js"]
    }
  }
}
```

> The extension auto-connects and auto-reconnects to `ws://127.0.0.1:9333`, so as long as Chrome is open, the tools will work.

## Configuration

Flags for `server.js`:

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `9333` | WebSocket bridge port (must match the extension) |
| `--display <n>` | `1` | Which physical display to target (1-based, prefers non-primary displays on macOS) |
| `--debug` | off | Verbose debug logging to stderr |

```bash
node server.js --debug --port 9333 --display 2
```

## Testing

A scripted client that exercises the tools against a local site:

```bash
node test-client.mjs
```

An end-to-end test that launches a Playwright Chrome instance with the extension pre-loaded:

```bash
node e2e.mjs
```

## Project structure

```
├── server.js              # MCP server + WebSocket bridge (all 13 tools)
├── extension/             # Chrome MV3 extension (CDP-based remote control)
│   ├── manifest.json
│   ├── background.js      # service worker: CDP attach, snapshot, tool exec
│   ├── popup.html/.js     # small status popup
│   └── icons
├── test-client.mjs        # MCP stdio smoke test
├── e2e.mjs                # Playwright + extension end-to-end test
└── package.json
```

## Notes

- The extension drives the tab through `chrome.debugger` (CDP), so it can act on the live page exactly like a human: real clicks, real keystrokes, real network state.
- `browser_snapshot` returns a compact accessibility tree (role, name, value, checked, `ref`). Every other interaction tool takes a `ref` from that snapshot, so run `browser_snapshot` after each interaction.
- Tool calls time out after 120s; if the extension disconnects, pending calls fail with a hint about reloading the extension.
