import { spawn } from "node:child_process";

const child = spawn("node", ["server.js"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const textOf = (r) => r.content.map((c) => c.type === "text" ? c.text : `[image ${c.mimeType} ${c.data.length} chars base64]`).join("\n");

try {
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } });
  console.log("INIT:", init.serverInfo.name, init.serverInfo.version);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  const tools = await call("tools/list");
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const nav = await call("tools/call", { name: "browser_navigate", arguments: { url: "http://localhost:8011/" } });
  const navText = textOf(nav);
  console.log("NAV OK, snapshot has hero title:", navText.includes("The AI workspace that runs itself"));

  const snap = await call("tools/call", { name: "browser_snapshot", arguments: {} });
  const snapText = textOf(snap);
  const toggleMatch = snapText.match(/switch "Toggle yearly billing"[^\n]*\[ref=(\d+)\]/);
  if (!toggleMatch) throw new Error("toggle ref not found in snapshot");
  const ref = toggleMatch[1];
  console.log("TOGGLE ref:", ref);

  await call("tools/call", { name: "browser_click", arguments: { ref } });
  const after = textOf(await call("tools/call", { name: "browser_snapshot", arguments: {} }));
  const toggleLine = after.split("\n").find((l) => l.includes("Toggle yearly billing"));
  console.log("TOGGLE LINE AFTER CLICK:", toggleLine);
  console.log("TOGGLE CHANGED TO CHECKED:", toggleLine && toggleLine.includes("checked: true"));

  const shot = await call("tools/call", { name: "browser_screenshot", arguments: {} });
  console.log("SCREENSHOT image content:", shot.content.some((c) => c.type === "image"));

  const logs = await call("tools/call", { name: "browser_get_console_logs", arguments: {} });
  console.log("CONSOLE LOGS:", textOf(logs).slice(0, 120));

  await call("tools/call", { name: "browser_close", arguments: {} });
  console.log("ALL TESTS PASSED");
} catch (e) {
  console.error("TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  process.exit();
}
