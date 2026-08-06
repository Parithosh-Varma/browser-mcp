"use strict";

const SERVER_URL = "ws://127.0.0.1:9333";

let ws = null;
let reconnectTimer = null;
let tabId = null;
let windowId = null;
let attached = false;
let consoleLogs = [];
let autoWindow = true;

const SNAPSHOT_FN = () => {
  const MAX = 600;
  let count = 0;
  const roleFromTag = (el) => {
    switch (el.tagName.toLowerCase()) {
      case "button": return "button";
      case "a": return "link";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "img": return "image";
      case "input": return el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : "textbox";
      case "textarea": return "textbox";
      case "select": return "combobox";
      case "summary": return "button";
      case "ul": case "ol": return "list";
      case "li": return "listitem";
      case "nav": return "navigation";
      case "main": return "main";
      case "footer": return "contentinfo";
      case "header": return "banner";
      case "form": return "form";
      case "details": return "group";
      case "dialog": return "dialog";
      case "menu": return "menu";
      default: return null;
    }
  };
  const isIgnored = (el) => {
    if (el.hidden) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const st = getComputedStyle(el);
    return st.display === "none" || st.visibility === "hidden";
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    if (el.tagName === "IMG") { const a = el.getAttribute("alt"); if (a) return a; }
    const ph = el.getAttribute("placeholder");
    if (ph) return ph;
    let t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > 120) t = t.slice(0, 120) + "...";
    return t;
  };
  const walk = (root) => {
    const nodes = [];
    for (const child of root.children) {      if (count >= MAX) break;
      if (isIgnored(child)) continue;
      let role = child.getAttribute("role") || roleFromTag(child);
      let node = null;
      if (role) {
        child.setAttribute("data-mcp-ref", String(count));
        const nodeInfo = { ref: String(count++), role, name: nameOf(child), tag: child.tagName.toLowerCase() };
        if (child.value !== undefined && String(child.value).length) nodeInfo.value = String(child.value).slice(0, 80);
        if (child.checked !== undefined) nodeInfo.checked = child.checked;
        const ariaChecked = child.getAttribute("aria-checked");
        if (ariaChecked !== null) nodeInfo.checked = ariaChecked === "true";
        node = nodeInfo;
      }
      const kids = walk(child);
      if (node) { node.children = kids; nodes.push(node); }
      else nodes.push.apply(nodes, kids);
    }
    return nodes;
  };
  if (!document.body) return [];
  return walk(document.body);
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeSnapshot(retries = 5) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const s = await snapshot();
      if (s.nodes !== undefined) return s;
    } catch (e) {
      lastErr = e;
    }
    await delay(400);
  }
  throw lastErr || new Error("snapshot failed");
}

// ---------- WebSocket bridge to the MCP server ----------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(SERVER_URL); } catch { scheduleReconnect(); return; }
  ws.onopen = () => {
    console.log("[browser-mcp] connected to server");
    send({ event: "hello" });
    if (autoWindow) send({ event: "window_setup_request" });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.event === "ping") { send({ event: "pong" }); return; }
    if (msg.event === "window_setup") { applyWindowSetup(msg); return; }
    if (msg.id !== undefined && typeof msg.tool === "string") {
      handleTool(msg).then((result) => {
        send({ id: msg.id, ok: true, result });
      }).catch((err) => {
        send({ id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
      });
    }
  };
  ws.onclose = () => {
    console.log("[browser-mcp] server connection lost");
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

// ---------- debugger / CDP control ----------

const isDebugTarget = (url) =>
  !url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("https://chrome.google.com/webstore");

async function ensureTab() {
  if (attached && tabId != null) return;
  let tab = null;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id === undefined || isDebugTarget(tab.url)) {
      tab = await chrome.tabs.create({ url: "https://example.com", active: true });
    }
    tabId = tab.id;
    windowId = tab.windowId;
  }
  await attach();
}

async function attach() {
  if (tabId == null) throw new Error("no tab to attach to");
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/already attached|Another debugger/i.test(err.message)) {
          attached = true;
          resolve();
        } else reject(new Error("attach failed: " + err.message));
        return;
      }
      attached = true;
      resolve();
    });
  });
  try { await cdp("Runtime.enable"); } catch {}
  try { await cdp("Page.enable"); } catch {}
}

function cdp(method, params = {}) {
  return new Promise(async (resolve, reject) => {
    try { await ensureTab(); } catch (e) { reject(e); return; }
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(method + ": " + err.message));
      else resolve(res);
    });
  });
}

async function evaluate(expression, awaitPromise = false) {
  const res = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    throw new Error("page error: " + (ex ? (ex.description || ex.value) : res.exceptionDetails.text));
  }
  return res.result ? res.result.value : undefined;
}

const CDP_KEY_MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MOD_NAMES = { Control: "ctrl", Meta: "meta", Alt: "alt", Shift: "shift" };

const KEY_TABLE = {
  Enter: { code: "Enter", key: "Enter", keyCode: 13 },
  Tab: { code: "Tab", key: "Tab", keyCode: 9 },
  Escape: { code: "Escape", key: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", key: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", key: "Home", keyCode: 36 },
  End: { code: "End", key: "End", keyCode: 35 },
  PageUp: { code: "PageUp", key: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", key: "PageDown", keyCode: 34 },
  Space: { code: "Space", key: " ", keyCode: 32, text: " " },
};

function parseKeySpec(spec) {
  const parts = String(spec).split("+");
  let modifiers = 0;
  const modNames = [];
  let key = parts[parts.length - 1];
  for (const p of parts.slice(0, -1)) {
    const canon = p[0].toUpperCase() + p.slice(1).toLowerCase();
    if (MOD_NAMES[canon]) { modifiers |= CDP_KEY_MODS[canon]; modNames.push(MOD_NAMES[canon]); }
    else if (canon === "Ctrl" || p.toLowerCase() === "ctrl") { modifiers |= 2; modNames.push("ctrl"); }
  }
  const base = KEY_TABLE[key] || (key.length === 1 ? { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: key.charCodeAt(0) } : { key, code: key, keyCode: 0 });
  const keyCode = base.keyCode === 0 ? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0) : base.keyCode;
  return {
    ...base,
    keyCode,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    text: modifiers === 0 && key.length === 1 ? key : undefined,
    command: modNames.join("+"),
  };
}

async function ensureActive() {
  if (tabId == null) return;
  try { await chrome.tabs.update(tabId, { active: true }); } catch {}
  if (windowId == null) {
    try { const t = await chrome.tabs.get(tabId); windowId = t.windowId; } catch {}
  }
  try { await chrome.windows.update(windowId, { focused: true }); } catch {}
}

async function pressKey(spec) {
  await ensureActive();
  const k = parseKeySpec(spec);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k });
  if (k.text !== undefined) {
    await cdp("Input.dispatchKeyEvent", { type: "char", key: k.key, code: k.code, text: k.text, keyCode: k.keyCode, modifiers: k.modifiers });
  }
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, keyCode: k.keyCode, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers });
}

async function elementCenter(ref) {
  const c = await evaluate(`(() => {
    const el = document.querySelector('[data-mcp-ref="${ref}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!c) throw new Error("ref not found: " + ref + " (run browser_snapshot first)");
  return c;
}

async function mouseClickAt(x, y) {
  await ensureActive();
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// ---------- snapshot ----------

async function snapshot() {
  const nodes = await evaluate("(" + SNAPSHOT_FN.toString() + ")()");
  const info = await evaluate("({ url: location.href, title: document.title })");
  return { url: info.url, title: info.title, nodes };
}

async function waitForLoad(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await evaluate("document.readyState").catch(() => "loading");
    if (ready === "complete") return;
    await delay(300);
  }
}

// ---------- tools ----------

const TOOLS = {
  async navigate({ url }) {
    if (!/^https?:/.test(url)) url = "https://" + url;
    if (isDebugTarget(url)) throw new Error("cannot navigate to " + url);
    await ensureTab();
    await cdp("Page.enable");
    await cdp("Page.navigate", { url });
    await waitForLoad();
    return safeSnapshot();
  },

  async snapshot() {
    await ensureTab();
    return safeSnapshot();
  },

  async click({ ref }) {
    const { x, y } = await elementCenter(ref);
    await mouseClickAt(x, y);
    await delay(150);
    return safeSnapshot();
  },

  async type({ ref, text, submit }) {
    const { x, y } = await elementCenter(ref);
    await mouseClickAt(x, y);
    await delay(80);
    await cdp("Input.insertText", { text });
    await delay(80);
    if (submit) await pressKey("Enter");
    await delay(300);
    return safeSnapshot();
  },

  async select_option({ ref, values }) {
    const vals = JSON.stringify(values);
    await evaluate(`(() => {
      const el = document.querySelector('[data-mcp-ref="${ref}"]');
      if (!el) throw new Error("ref not found: ${ref}");
      const wanted = ${vals};
      for (const opt of el.options) {
        if (wanted.includes(opt.value) || wanted.includes(opt.text)) opt.selected = true;
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    return safeSnapshot();
  },

  async press_key({ key }) {
    await pressKey(key);
    return safeSnapshot();
  },

  async hover({ ref }) {
    await ensureActive();
    const { x, y } = await elementCenter(ref);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await delay(150);
    return safeSnapshot();
  },

  async wait({ seconds }) {
    await delay(seconds * 1000);
    return safeSnapshot();
  },

  async back() {
    await cdp("Page.enable");
    const nav = await cdp("Page.getNavigationHistory");
    const idx = nav.currentIndex - 1;
    const entry = nav.entries[idx];
    if (!entry) throw new Error("no back history");
    await cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
    await waitForLoad();
    return safeSnapshot();
  },

  async forward() {
    await cdp("Page.enable");
    const nav = await cdp("Page.getNavigationHistory");
    const idx = nav.currentIndex + 1;
    const entry = nav.entries[idx];
    if (!entry) throw new Error("no forward history");
    await cdp("Page.navigateToHistoryEntry", { entryId: entry.id });
    await waitForLoad();
    return safeSnapshot();
  },

  async screenshot() {
    await ensureTab();
    const res = await cdp("Page.captureScreenshot", { format: "png" });
    return { data: res.data };
  },

  async console_logs() {
    const logs = consoleLogs;
    consoleLogs = [];
    return { text: logs.length ? logs.join("\n") : "No console output." };
  },

  async close() {
    if (tabId != null) {
      try { await new Promise((r) => chrome.debugger.detach({ tabId }, r)); } catch {}
      try { await chrome.tabs.remove(tabId); } catch {}
    }
    tabId = windowId = null;
    attached = false;
    return { text: "Browser closed." };
  },
};

async function handleTool(msg) {
  const fn = TOOLS[msg.tool];
  if (!fn) throw new Error("unknown tool: " + msg.tool);
  return fn(msg.params || {});
}

// ---------- window placement ----------

async function applyWindowSetup(msg) {
  const d = msg.display;
  if (!d || tabId == null) return;
  if (windowId == null) {
    try { const t = await chrome.tabs.get(tabId); windowId = t.windowId; } catch { return; }
  }
  try {
    await chrome.windows.update(windowId, { left: d.x, top: d.y, width: d.width, height: d.height });
  } catch (e) {
    console.log("[browser-mcp] window setup failed:", e.message);
  }
}

// ---------- debugger events ----------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;
  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args || []).map((a) => a.value !== undefined ? String(a.value) : a.description || "").join(" ");
    consoleLogs.push("[" + params.type + "] " + args);
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails;
    consoleLogs.push("[pageerror] " + (d.exception ? d.exception.description || d.exception.value : d.text || ""));
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === tabId) {
    attached = false;
    console.log("[browser-mcp] debugger detached from tab", tabId);
  }
});

// ---------- popup messaging ----------

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === "getStatus") {
    respond({
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      tabId,
      autoWindow,
    });
    return true;
  }
  if (msg.type === "reconnect") {
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    connect();
    respond({ ok: true });
    return true;
  }
  if (msg.type === "setAutoWindow") {
    autoWindow = !!msg.on;
    chrome.storage.local.set({ autoWindow });
    respond({ ok: true });
    return true;
  }
  if (msg.type === "attachNow") {
    ensureTab().then(() => respond({ ok: true, tabId })).catch((e) => respond({ ok: false, error: e.message }));
    return true;
  }
});

// ---------- boot ----------

chrome.storage.local.get({ autoWindow: true }, (s) => {
  autoWindow = s.autoWindow;
  connect();
  chrome.runtime.onStartup.addListener(() => connect());
  chrome.runtime.onInstalled.addListener(() => connect());
});
