<div align="center">

<img src="extension/icon128.png" alt="browser-mcp logo" width="128" height="128">

# browser-mcp

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP SDK](https://img.shields.io/badge/MCP-SDK%20v1.0-black)](https://github.com/modelcontextprotocol/typescript-sdk)

A Model Context Protocol (MCP) server that provides AI assistants with direct, real-time control over a Google Chrome browser instance. Through a lightweight Chrome extension, the server drives live browser sessions — navigation, interaction, inspection, and capture — exposing them to any MCP-compatible client (Claude, opencode, and others) as a clean, typed tool interface.

</div>

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tools](#tools)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
  - [1. Load the Extension](#1-load-the-extension)
  - [2. Start the Server](#2-start-the-server)
  - [3. Connect an MCP Client](#3-connect-an-mcp-client)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [License](#license)

## Overview

`browser-mcp` is designed for AI-driven browser automation that must operate on a *real* user session — preserving login state, cookies, and visible windows — rather than an isolated headless environment. Key characteristics:

- **Real browser control**: The controlled tab is a live Chrome window on the user's desktop. The agent interacts with it exactly as a human would, with full access to existing sessions and extensions.
- **Standards-based**: Implements the Model Context Protocol over stdio using the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- **CDP-powered**: The extension drives the tab via the Chrome DevTools Protocol (`chrome.debugger` API), enabling accurate accessibility snapshots, console observation, and screenshots without a browser driver dependency.
- **Minimal footprint**: No Playwright browser downloads or separate driver processes are required to operate; Playwright is used only in the test harness.

## Architecture

```
┌─────────────────────┐    stdio (JSON-RPC)    ┌──────────────────────────┐    WebSocket 127.0.0.1:9333    ┌────────────────────────┐
│                     │ ─────────────────────▶ │                          │ ────────────────────────────▶ │                        │
│  MCP client         │                        │  server.js               │                                │  Chrome extension      │
│  (Claude, opencode, │                        │  ├─ MCP tool definitions │                                │  (MV3 service worker)  │
│  any MCP host)      │                        │  └─ WebSocket bridge     │ ◀────────────────────────────  │  ├─ chrome.debugger     │
│                     │ ◀───────────────────── │                          │                                │  └─ tab automation     │
└─────────────────────┘                        └──────────────────────────┘                                └────────────────────────┘
```

The system comprises three components:

1. **MCP server** (`server.js`) — Registers the browser tool set and serves it over stdio. An embedded WebSocket server bridges tool invocations to the extension.
2. **WebSocket bridge** — A localhost-only listener (`127.0.0.1:9333`) that multiplexes request/response messages between the MCP server and the extension, with per-call timeouts and reconnection handling.
3. **Chrome extension** (`extension/`) — An MV3 extension that connects to the bridge, attaches to a tab via CDP, executes requested actions, and returns accessibility-tree snapshots, screenshots, and console logs.

This three-tier design keeps the MCP interface standard while isolating all browser-specific machinery inside the extension, making the server portable and the transport auditable.

## Tools

The server exposes the following tools:

| Tool | Description |
|---|---|
| `browser_navigate` | Opens a URL in the controlled tab and returns the updated page snapshot |
| `browser_snapshot` | Returns the accessibility tree of the current page with element `ref` identifiers |
| `browser_click` | Clicks an element identified by its `ref` |
| `browser_type` | Types text into a textbox or textarea; optionally submits with Enter |
| `browser_select_option` | Selects one or more options in a dropdown |
| `browser_press_key` | Dispatches keyboard input (Enter, Escape, ArrowDown, Tab, Meta+K, …) |
| `browser_hover` | Moves the cursor over an element, e.g. to reveal hover menus |
| `browser_wait` | Waits a specified number of seconds for transitions or animations |
| `browser_back` | Navigates backward in history |
| `browser_forward` | Navigates forward in history |
| `browser_screenshot` | Captures a PNG screenshot of the current page |
| `browser_get_console_logs` | Retrieves console messages and page errors logged since the last call |
| `browser_close` | Closes the controlled tab and detaches the debugger |

Interaction tools (`browser_click`, `browser_type`, and others) require a `ref` obtained from `browser_snapshot`; callers should refresh the snapshot after each interaction, as refs are re-generated.

## Requirements

| Component | Requirement |
|---|---|
| Node.js | ≥ 18 |
| Browser | Google Chrome (or Chromium) — MV3 extension support required |
| OS | macOS (fully supported, including automatic multi-display targeting); other platforms fall back to the primary display |
| MCP client | Any host that supports external MCP servers over stdio |

## Installation

```bash
npm install
```

## Configuration

Command-line flags for `server.js`:

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `9333` | Port for the WebSocket extension bridge (must match the extension's configured endpoint) |
| `--display <n>` | `1` | Physical display to target, 1-based. Prefers secondary displays on macOS when available |
| `--debug` | off | Enables verbose debug logging on stderr |

Example:

```bash
node server.js --port 9333 --display 2 --debug
```

The debug log prints bridge status, connection events, and per-tool diagnostics to stderr. Standard JSON-RPC traffic is emitted on stdout.

## Usage

### 1. Load the Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` directory of this repository.
4. Optionally pin the **browser-mcp controller** extension to the toolbar for quick status inspection.

### 2. Start the Server

```bash
npm start
```

Expected output on stderr:

```
[browser-mcp] extension bridge listening on ws://127.0.0.1:9333
[browser-mcp] extension connected
[browser-mcp] targeting display 1 of 2 at x=1920 y=0 1920x1080
```

The extension connects automatically and reconnects on interruption, so the server can be restarted independently of Chrome.

### 3. Connect an MCP Client

Register the server in your MCP client's configuration. Example for Claude Code / opencode:

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

Once connected, the client can invoke the tool set, e.g.:

1. `browser_navigate` with a target URL.
2. `browser_snapshot` to obtain element refs.
3. `browser_click` / `browser_type` on the desired refs.
4. `browser_screenshot` to verify state visually.

## Testing

A scripted stdio client that exercises the full tool flow:

```bash
node test-client.mjs
```

An end-to-end test that launches a Playwright-controlled Chrome instance with the extension pre-loaded:

```bash
node e2e.mjs
```

## Project Structure

```
browser-mcp/
├── server.js              # MCP server, tool definitions, WebSocket bridge
├── extension/             # Chrome MV3 extension (CDP-based tab automation)
│   ├── manifest.json      # Extension manifest (permissions, service worker)
│   ├── background.js      # CDP attach, snapshot rendering, tool execution
│   ├── popup.html         # Status popup UI
│   ├── popup.js           # Popup logic
│   └── icons/             # Extension icons (16/32/48/128)
├── test-client.mjs        # MCP stdio smoke test
├── e2e.mjs                # End-to-end test with Playwright
├── package.json
└── README.md
```

## License

MIT © 2026 Parithosh Varma
