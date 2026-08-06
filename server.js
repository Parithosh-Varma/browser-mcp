import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { execFileSync } from "node:child_process";

const DEBUG = process.argv.includes("--debug");
const PORT = parseInt(process.argv[process.argv.indexOf("--port") + 1] ?? "9333", 10) || 9333;
const DISPLAY_INDEX = parseInt(process.argv[process.argv.indexOf("--display") + 1] ?? "1", 10) || 1;
const log = (...a) => { if (DEBUG) console.error("[browser-mcp]", ...a); };
const status = (...a) => console.error("[browser-mcp]", ...a);

const SWIFT_DISPLAYS = [
  "import CoreGraphics",
  "var count: UInt32 = 0",
  "CGGetActiveDisplayList(0, nil, &count)",
  "var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))",
  "CGGetActiveDisplayList(count, &ids, &count)",
  "for id in ids {",
  "  let b = CGDisplayBounds(id)",
  '  print("\\(Int(b.origin.x)) \\(Int(b.origin.y)) \\(Int(b.size.width)) \\(Int(b.size.height))")',
  "}",
].join("\n");

function detectDisplays() {
  try {
    const out = execFileSync("swift", ["-e", SWIFT_DISPLAYS], { timeout: 15000 }).toString();
    const displays = [];
    for (const line of out.split("\n")) {
      const [x, y, w, h] = line.trim().split(/\s+/).map(Number);
      if ([x, y, w, h].every(Number.isFinite) && w && h) displays.push({ x, y, width: w, height: h });
    }
    return displays;
  } catch (e) {
    status("display detection failed:", e.message);
    return null;
  }
}

function targetDisplay() {
  const displays = detectDisplays();
  if (!displays || !displays.length) return null;
  const secondary = displays.filter((d) => d.x !== 0 || d.y !== 0);
  const ordered = secondary.length ? secondary : displays;
  const target = ordered[DISPLAY_INDEX - 1] ?? ordered[0];
  status(
    "targeting display", DISPLAY_INDEX,
    "of", displays.length,
    "at x=" + target.x, "y=" + target.y,
    target.width + "x" + target.height
  );
  return target;
}

// ---------- WebSocket bridge to the Chrome extension ----------

let client = null;
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("listening", () => status("extension bridge listening on ws://127.0.0.1:" + PORT));
wss.on("error", (e) => status("bridge error:", e.message));

wss.on("connection", (ws) => {
  if (client && client !== ws) {
    status("replacing previous extension connection");
    try { client.close(); } catch {}
  }
  client = ws;
  status("extension connected");

  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ event: "ping" }));
  }, 20000);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "hello") {
      status("extension hello");
      const disp = targetDisplay();
      ws.send(JSON.stringify({
        event: "window_setup",
        display: disp,
      }));
      return;
    }
    if (msg.event === "pong") return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "extension error"));
    }
  });

  ws.on("close", () => {
    if (client === ws) client = null;
    clearInterval(ping);
    status("extension disconnected");
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("extension disconnected"));
    }
    pending.clear();
  });
  ws.on("error", () => {});
});

function call(tool, params, timeoutMs = 120000) {
  status("DBG call", tool, "client=", client ? "present(readyState=" + client.readyState + ")" : "missing");
  if (!client || client.readyState !== 1) {
    return Promise.reject(new Error(
      "Browser extension is not connected. Load the extension/ folder in chrome://extensions (Developer mode -> Load unpacked) and keep the server running."
    ));
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("tool '" + tool + "' timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ id, tool, params }));
  });
}

// ---------- snapshot rendering ----------

function renderTree(nodes, depth = 0) {
  let out = "";
  for (const n of nodes) {
    let line = "  ".repeat(depth) + "- " + n.role;
    if (n.name) line += ' "' + n.name + '"';
    if (n.value !== undefined) line += ' (value: "' + n.value + '")';
    if (n.checked !== undefined) line += " (checked: " + n.checked + ")";
    line += " [ref=" + n.ref + "]";
    out += line + "\n";
    if (n.children && n.children.length) out += renderTree(n.children, depth + 1);
  }
  return out;
}

async function snapshotText() {
  const s = await call("snapshot");
  return "URL: " + s.url + "\nTitle: " + s.title + "\n" + renderTree(s.nodes || []);
}

async function snapshotResult() {
  return { content: [{ type: "text", text: await snapshotText() }] };
}

const server = new McpServer({ name: "browser-mcp", version: "2.0.0" });

server.registerTool(
  "browser_navigate",
  {
    title: "Navigate",
    description: "Open a URL in the Chrome tab controlled by the extension. Returns the page snapshot with element refs.",
    inputSchema: { url: z.string().describe("Full URL to open, e.g. https://example.com") }
  },
  async ({ url }) => {
    status("navigate ->", url);
    const r = await call("navigate", { url });
    status("page loaded:", r.title);
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_snapshot",
  {
    title: "Snapshot",
    description: "Return the current accessibility tree of the page with element refs. Elements are addressed by their ref in every other tool. Run this after every interaction.",
    inputSchema: {}
  },
  async () => snapshotResult()
);

server.registerTool(
  "browser_click",
  {
    title: "Click",
    description: "Click an element identified by its ref from the snapshot. After clicking, returns an updated snapshot.",
    inputSchema: { ref: z.string().describe("Element ref, e.g. '42'") }
  },
  async ({ ref }) => {
    status("click ref", ref);
    const r = await call("click", { ref });
    status("click done, snapshot updated");
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_type",
  {
    title: "Type",
    description: "Type text into a textbox/textarea identified by ref. Optionally press Enter after (submit=true) and get the updated snapshot.",
    inputSchema: {
      ref: z.string().describe("Element ref"),
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing (default false)")
    }
  },
  async ({ ref, text, submit }) => {
    status("type ref", ref, "->", JSON.stringify(text), submit ? "(Enter)" : "");
    const r = await call("type", { ref, text, submit: !!submit });
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_select_option",
  {
    title: "Select option",
    description: "Select one or more options in a dropdown (combobox) identified by ref. Values are the option text or value.",
    inputSchema: {
      ref: z.string().describe("Element ref"),
      values: z.array(z.string()).describe("Option value(s) to select")
    }
  },
  async ({ ref, values }) => {
    status("select ref", ref, "->", values.join(", "));
    const r = await call("select_option", { ref, values });
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_press_key",
  {
    title: "Press key",
    description: "Press a keyboard key, e.g. Enter, Escape, ArrowDown, Tab, Control+A, Meta+K.",
    inputSchema: { key: z.string().describe("Key name") }
  },
  async ({ key }) => {
    status("press key", key);
    const r = await call("press_key", { key });
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_hover",
  {
    title: "Hover",
    description: "Move the mouse over an element identified by ref (useful for hover menus).",
    inputSchema: { ref: z.string().describe("Element ref") }
  },
  async ({ ref }) => {
    status("hover ref", ref);
    const r = await call("hover", { ref });
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_wait",
  {
    title: "Wait",
    description: "Wait a number of seconds (for page transitions or animations).",
    inputSchema: { seconds: z.number().describe("Seconds to wait") }
  },
  async ({ seconds }) => {
    status("wait", seconds, "s");
    const r = await call("wait", { seconds });
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_back",
  { title: "Go back", description: "Navigate back in history.", inputSchema: {} },
  async () => {
    status("go back");
    const r = await call("back");
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_forward",
  { title: "Go forward", description: "Navigate forward in history.", inputSchema: {} },
  async () => {
    status("go forward");
    const r = await call("forward");
    return { content: [{ type: "text", text: "URL: " + r.url + "\nTitle: " + r.title + "\n" + renderTree(r.nodes || []) }] };
  }
);

server.registerTool(
  "browser_screenshot",
  {
    title: "Screenshot",
    description: "Take a screenshot of the current page. Returns the image.",
    inputSchema: {}
  },
  async () => {
    status("taking screenshot");
    const r = await call("screenshot");
    return {
      content: [
        { type: "image", data: r.data, mimeType: "image/png" },
        { type: "text", text: "Screenshot taken. Use browser_snapshot for element refs." }
      ]
    };
  }
);

server.registerTool(
  "browser_get_console_logs",
  { title: "Console logs", description: "Get console messages and page errors collected since the last call.", inputSchema: {} },
  async () => {
    const r = await call("console_logs");
    return { content: [{ type: "text", text: r.text }] };
  }
);

server.registerTool(
  "browser_close",
  { title: "Close tab", description: "Close the controlled Chrome tab and detach.", inputSchema: {} },
  async () => {
    status("close tab");
    const r = await call("close");
    return { content: [{ type: "text", text: r.text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready");

process.on("SIGINT", () => {
  try { wss.close(); } catch {}
  process.exit(0);
});
