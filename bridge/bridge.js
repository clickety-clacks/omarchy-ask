#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const agentName = process.env.ASK_AGENT === "codex" ? "codex" : "claude";
const agentBinary = join(
  here,
  "node_modules",
  ".bin",
  agentName === "codex" ? "codex-acp" : "claude-agent-acp",
);
const cwd = process.env.ASK_CWD || process.env.HOME || process.cwd();

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function messageText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text || "";
  return "";
}

const child = spawn(agentBinary, [], {
  cwd,
  env: { ...process.env, HUGINN_INTERNAL: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    if (line.trim()) emit({ type: "diagnostic", text: line.trim() });
  }
});

const pendingPermissions = new Map();
let permissionSequence = 0;
let sessionId = null;
let connection = null;
let turnRunning = false;
let shuttingDown = false;

const client = {
  sessionUpdate(params) {
    const update = params.update || {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = messageText(update.content);
        if (text) emit({ type: "text", text });
        break;
      }
      case "tool_call":
      case "tool_call_update":
        emit({
          type: "tool",
          id: update.toolCallId || "",
          title: update.title || update.name || "Using a tool",
          status: update.status || "in_progress",
        });
        break;
      case "agent_thought_chunk":
        emit({ type: "status", text: "Thinking…" });
        break;
      default:
        break;
    }
    return Promise.resolve();
  },

  requestPermission(params) {
    const requestId = `permission-${++permissionSequence}`;
    const title = params.toolCall?.title || params.toolCall?.name || "Use a tool";
    const options = (params.options || []).map((option) => ({
      id: option.optionId,
      label: option.name,
      kind: option.kind,
    }));
    emit({ type: "permission", id: requestId, title, options });
    return new Promise((resolve) => {
      pendingPermissions.set(requestId, { resolve, options });
    });
  },
};

async function start() {
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  connection = new ClientSideConnection(() => client, stream);
  const initialized = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const session = await connection.newSession({ cwd, mcpServers: [] });
  sessionId = session.sessionId;
  emit({
    type: "ready",
    agent: agentName,
    sessionId,
    capabilities: initialized.agentCapabilities || {},
  });
}

async function prompt(text) {
  if (!connection || !sessionId) throw new Error("ACP session is not ready");
  if (turnRunning) throw new Error("The agent is already handling a prompt");
  turnRunning = true;
  emit({ type: "status", text: "Thinking…" });
  try {
    const response = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
    emit({ type: "done", stopReason: response.stopReason || "end_turn" });
  } finally {
    turnRunning = false;
  }
}

function answerPermission(message) {
  const pending = pendingPermissions.get(message.id);
  if (!pending) return;
  pendingPermissions.delete(message.id);
  const wantedKind = message.allow ? "allow_once" : "reject_once";
  const option = pending.options.find((item) => item.kind === wantedKind)
    || pending.options.find((item) => message.allow
      ? item.kind.startsWith("allow")
      : item.kind.startsWith("reject"));
  if (option) {
    pending.resolve({ outcome: { outcome: "selected", optionId: option.id } });
  } else {
    pending.resolve({ outcome: { outcome: "cancelled" } });
  }
  emit({ type: "status", text: message.allow ? "Working…" : "Tool denied" });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { resolve } of pendingPermissions.values()) {
    resolve({ outcome: { outcome: "cancelled" } });
  }
  pendingPermissions.clear();
  try {
    if (connection && sessionId) await connection.closeSession({ sessionId });
  } catch {}
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 500).unref();
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    emit({ type: "error", message: "Invalid UI command" });
    return;
  }
  if (message.type === "prompt") {
    prompt(String(message.text || "")).catch((error) => {
      turnRunning = false;
      emit({ type: "error", message: error.message || String(error) });
    });
  } else if (message.type === "permission") {
    answerPermission(message);
  } else if (message.type === "cancel" && connection && sessionId) {
    connection.cancel({ sessionId }).catch(() => {});
  } else if (message.type === "close") {
    shutdown().finally(() => process.exit(0));
  }
});
input.on("close", () => shutdown());

child.on("exit", (code, signal) => {
  if (!shuttingDown) {
    emit({ type: "fatal", message: `ACP agent exited (${signal || code})` });
  }
  process.exit(code || 0);
});
child.on("error", (error) => {
  emit({ type: "fatal", message: error.message });
  process.exit(1);
});

process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));

start().catch((error) => {
  emit({ type: "fatal", message: error.message || String(error) });
  child.kill("SIGTERM");
  process.exit(1);
});
