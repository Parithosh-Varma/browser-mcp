"use strict";

const $ = (id) => document.getElementById(id);
const banner = $("status-banner");
const statusLabel = $("status-label");
const latencyEl = $("latency");
const logBody = $("console-body");
const consoleHdr = $("console-hdr");
const consoleIndicator = $("console-indicator");
const reconnectSvg = $("reconnect-svg");

const SERVER_URL = "ws://127.0.0.1:9333";

function log(msg) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const t = new Date().toTimeString().slice(0, 8);
  const content = document.createElement("span");
  content.className = "log-content";
  content.textContent = msg;
  const ts = document.createElement("span");
  ts.className = "log-timestamp";
  ts.textContent = "[" + t + "]";
  entry.appendChild(ts);
  entry.appendChild(content);
  logBody.appendChild(entry);
  logBody.scrollTop = logBody.scrollHeight;
}

function setStatus(connected) {
  banner.classList.toggle("connecting", !connected);
  statusLabel.textContent = connected ? "CONNECTED TO ACTIVE TAB" : "SERVER OFFLINE";
  latencyEl.textContent = connected ? "ONLINE" : "OFFLINE";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (s) => {
    if (!s) return;
    setStatus(s.connected);
    $("server-id").textContent = "ID: " + (s.tabId != null ? s.tabId : "--");
  });
}

$("reconnect-btn").addEventListener("click", () => {
  banner.classList.add("connecting");
  statusLabel.textContent = "ATTEMPTING HANDSHAKE...";
  latencyEl.textContent = "OFFLINE";
  reconnectSvg.classList.add("spinner");
  log("POST /session/reconnect");
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    setTimeout(() => {
      reconnectSvg.classList.remove("spinner");
      refresh();
    }, 200);
  });
});

let controlActive = false;
$("control-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "attachNow" }, (r) => {
    controlActive = !!r || (r && r.ok);
    if (r && r.error) {
      log("ERROR: " + r.error);
      return;
    }
    if (controlActive) {
      log("STDOUT: Assigned pointer keys to tab [" + (r && r.tabId) + "]");
      statusLabel.textContent = "EXCLUSIVE REMOTE ACTIVE";
    }
    refresh();
  });
});

consoleHdr.addEventListener("click", () => {
  logBody.classList.toggle("collapsed");
  consoleIndicator.classList.toggle("collapsed");
});

log("MCP engine initialised at port 9333");
log("Active instance loaded via Chromium environment");
refresh();
