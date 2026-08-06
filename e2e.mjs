import { chromium } from "playwright";
import { spawn } from "node:child_process";

const EXT = "/Users/varma/Downloads/SANDBOX/SANDBOX1/browser-mcp/extension";
const server = spawn("node", ["server.js"], { stdio: ["pipe", "pipe", "pipe"] });
server.stderr.on("data", (d) => {
  if (d.toString().includes("extension connected")) gotConnected = true;
});
let gotConnected = false;

let buf = "";
const pending = new Map();
let nextId = 1;
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const call = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error("timeout " + method)); }, 60000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
};
const textOf = (r) => r.content.map((c) => c.type === "text" ? c.text : "[image]").join("\n");

try {
  await new Promise((r) => setTimeout(r, 1200));
  const ctx = await chromium.launchPersistentContext("/tmp/e2e-pw", {
    headless: false,
    args: ["--disable-extensions-except=" + EXT, "--load-extension=" + EXT],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  console.log("browser launched");

  for (let i = 0; i < 25 && !gotConnected; i++) await new Promise((r) => setTimeout(r, 1000));
  console.log("extension connected to MCP server:", gotConnected);

  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  const nav = textOf(await call("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com/" } }));
  console.log("NAV heading ok:", nav.includes('heading "Example Domain"'));
  console.log(nav.split("\n").slice(0, 4).join("\n"));

  const snap = textOf(await call("tools/call", { name: "browser_snapshot", arguments: {} }));
  const linkMatch = snap.match(/link "[^"]*"[^\n]*\[ref=(\d+)\]/);
  console.log("link ref found:", !!linkMatch);

  const after = textOf(await call("tools/call", { name: "browser_click", arguments: { ref: linkMatch[1] } }));
  console.log("after click URL line:", after.split("\n")[0]);
  console.log("after click on iana.org:", after.includes("iana.org"));

  const shot = await call("tools/call", { name: "browser_screenshot", arguments: {} });
  console.log("screenshot image:", shot.content.some((c) => c.type === "image"));

  const logs = textOf(await call("tools/call", { name: "browser_get_console_logs", arguments: {} }));
  console.log("console logs:", logs.slice(0, 60));

  const closed = textOf(await call("tools/call", { name: "browser_close", arguments: {} }));
  console.log("close:", closed);

  console.log("E2E DONE");
} catch (e) {
  console.log("E2E FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  process.exit();
}
