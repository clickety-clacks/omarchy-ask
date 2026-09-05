#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolveHarness, resolveExecutable } from "./harness-policy.js";
import { explainHarnessError, needsNewSession } from "./harness-errors.js";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const here = dirname(fileURLToPath(import.meta.url));
function startupValue(resolve) {
  try { return resolve(); }
  catch (error) {
    emit({ type: "fatal", message: error.message });
    process.exit(1);
  }
}
const agentName = startupValue(() => resolveHarness());
const bundledAgentBinary = join(
  here,
  "node_modules",
  ".bin",
  agentName === "codex" ? "codex-acp" : "claude-agent-acp",
);
function configuredAgentCommand() {
  const specificName = agentName === "codex"
    ? "ASK_CODEX_ACP_COMMAND" : "ASK_CLAUDE_ACP_COMMAND";
  const raw = String(process.env[specificName]
    || process.env.ASK_ACP_COMMAND || "").trim();
  if (!raw) return [bundledAgentBinary];
  let command;
  try { command = JSON.parse(raw); }
  catch { throw new Error("ASK_ACP_COMMAND must be a JSON array of arguments"); }
  if (!Array.isArray(command) || command.length === 0
      || command.some((argument) => typeof argument !== "string" || argument === ""))
    throw new Error("ASK_ACP_COMMAND must be a non-empty JSON array of non-empty strings");
  return command;
}
const agentCommand = startupValue(configuredAgentCommand);
const cwd = process.env.ASK_CWD || process.env.HOME || process.cwd();
const settingsDir = join(process.env.HOME || process.cwd(), ".config", "omarchy");
const settingsPath = join(settingsDir, "ask.json");

let permissionMode = "permission";

async function loadSettings() {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    permissionMode = settings.permissionMode === "yolo" ? "yolo" : "permission";
  } catch {}
}

async function savePermissionMode(mode) {
  const nextMode = mode === "yolo" ? "yolo" : "permission";
  await mkdir(settingsDir, { recursive: true });
  // The UI writes its own keys (font scale) to this file. Merge rather than
  // replace so toggling the mode cannot drop them.
  let settings = {};
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {}
  settings.permissionMode = nextMode;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  permissionMode = nextMode;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function messageText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text || "";
  return "";
}

function flatOptions(options) {
  const result = [];
  for (const option of options || []) {
    if (Array.isArray(option.options)) result.push(...option.options);
    else result.push(option);
  }
  return result;
}

function matchingValue(config, wanted) {
  if (!wanted) return "";
  const option = flatOptions(config?.options).find(candidate => candidate.value === wanted);
  return option?.value || "";
}

async function applyRequestedModel(configOptions) {
  if (process.env.ASK_INSPECT_CONFIG === "1")
    emit({ type: "config_options", configOptions });
  const requests = [
    { wanted: process.env.ASK_MODEL, ids: ["model"], categories: ["model"] },
    { wanted: process.env.ASK_REASONING_EFFORT,
      ids: ["reasoning_effort"], categories: ["thought_level"] },
  ];
  for (const request of requests) {
    if (!request.wanted) continue;
    const config = (configOptions || []).find((option) =>
      request.ids.includes(option.id) || request.categories.includes(option.category));
    // Claude's adapter resolves exact version IDs against its SDK metadata,
    // including versioned IDs exposed under aliases such as opus[1m].
    const value = matchingValue(config, request.wanted)
      || (agentName === "claude" && config?.category === "model" ? request.wanted : "");
    if (!config || !value) {
      throw new Error(`Configured ACP option unavailable: ${request.wanted}`);
    }
    const response = await connection.setSessionConfigOption({
      sessionId,
      configId: config.id,
      value,
    });
    configOptions = response.configOptions || configOptions;
    if (process.env.ASK_INSPECT_CONFIG === "1")
      emit({ type: "config_options", configOptions });
  }
}

const childEnvironment = { ...process.env, HUGINN_INTERNAL: "1" };
// ACP is the transport adapter; the installed system harness owns execution.
// Explicit deployment overrides retain precedence. Never silently use the
// adapter's transitive harness dependency when the system install is absent.
if (agentName === "codex")
  childEnvironment.CODEX_PATH = startupValue(() => resolveExecutable(agentName));
else
  childEnvironment.CLAUDE_CODE_EXECUTABLE = startupValue(() => resolveExecutable(agentName));
if (agentName === "codex") {
  let codexConfig = {};
  try { codexConfig = JSON.parse(process.env.CODEX_CONFIG || "{}"); } catch {}
  if (process.env.ASK_MODEL) codexConfig.model = process.env.ASK_MODEL;
  if (process.env.ASK_REASONING_EFFORT)
    codexConfig.model_reasoning_effort = process.env.ASK_REASONING_EFFORT;
  childEnvironment.CODEX_CONFIG = JSON.stringify(codexConfig);
}

const child = spawn(agentCommand[0], agentCommand.slice(1), {
  cwd,
  env: childEnvironment,
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
let steeringSupported = false;
let shuttingDown = false;
let childExitResolve;
const childExited = new Promise((resolve) => { childExitResolve = resolve; });

const client = {
  sessionUpdate(params) {
    const update = params.update || {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = messageText(update.content);
        if (text) emit({ type: "text", text, messageId: update.messageId || "" });
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
    if (permissionMode === "yolo") {
      const option = options.find((item) => item.kind === "allow_once");
      if (option) {
        emit({ type: "status", text: `YOLO · ${title}` });
        return Promise.resolve({ outcome: { outcome: "selected", optionId: option.id } });
      }
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    emit({ type: "permission", id: requestId, title, options });
    return new Promise((resolve) => {
      pendingPermissions.set(requestId, { resolve, options });
    });
  },
};

async function start() {
  await loadSettings();
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  connection = new ClientSideConnection(() => client, stream);
  const initialized = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { session: { configOptions: {} } },
  });
  steeringSupported = initialized?._meta?.steering?.supported === true;
  const session = await connection.newSession({ cwd, mcpServers: [],
    ...(agentName === "claude" && process.env.ASK_MODEL ? {
      _meta: { claudeCode: { options: {
        model: process.env.ASK_MODEL,
        settings: { model: process.env.ASK_MODEL, availableModels: [process.env.ASK_MODEL] },
      } } },
    } : {}),
  });
  sessionId = session.sessionId;
  await applyRequestedModel(session.configOptions || []);
  emit({
    type: "ready",
    agent: agentName,
    sessionId,
    capabilities: initialized.agentCapabilities || {},
    steeringSupported,
    permissionMode,
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

async function steer(text) {
  if (!connection || !sessionId) throw new Error("ACP session is not ready");
  if (!turnRunning) throw new Error("There is no active turn to steer");
  if (!steeringSupported) throw new Error("This ACP agent does not support steering");
  const response = await connection.request("_session/steering", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  const outcome = response?.outcome || "failed";
  if (outcome === "failed") throw new Error("The agent could not apply the steering prompt");
  emit({ type: "steered", outcome });
}

function answerPermission(message) {
  const pending = pendingPermissions.get(message.id);
  if (!pending) return;
  pendingPermissions.delete(message.id);
  const wantedKind = message.allow ? "allow_once" : "reject_once";
  const option = pending.options.find((item) => item.kind === wantedKind);
  if (option) {
    pending.resolve({ outcome: { outcome: "selected", optionId: option.id } });
  } else {
    pending.resolve({ outcome: { outcome: "cancelled" } });
  }
  emit({ type: "status", text: message.allow ? "Working…" : "Tool denied" });
}

function allowAllPendingPermissions() {
  for (const [id, pending] of pendingPermissions.entries()) {
    const option = pending.options.find((item) => item.kind === "allow_once");
    pendingPermissions.delete(id);
    pending.resolve(option
      ? { outcome: { outcome: "selected", optionId: option.id } }
      : { outcome: { outcome: "cancelled" } });
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { resolve } of pendingPermissions.values()) {
    resolve({ outcome: { outcome: "cancelled" } });
  }
  pendingPermissions.clear();
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  // Bound graceful ACP close before signalling the child. Remain alive long
  // enough to reap it; a detached kill timer cannot help after bridge exit.
  try {
    if (connection && sessionId)
      await Promise.race([connection.closeSession({ sessionId }), delay(350)]);
  } catch {}
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([childExited, delay(500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([childExited, delay(150)]);
  }
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
      const fatal = needsNewSession(error);
      emit({ type: fatal ? "fatal" : "error", message: explainHarnessError(error, agentName) });
      if (fatal) shutdown().finally(() => process.exit(1));
    });
  } else if (message.type === "steer") {
    steer(String(message.text || "")).catch((error) => {
      emit({ type: "steering_error", message: error.message || String(error) });
    });
  } else if (message.type === "permission") {
    answerPermission(message);
  } else if (message.type === "permission_mode") {
    savePermissionMode(message.mode).then(() => {
      if (permissionMode === "yolo") allowAllPendingPermissions();
      emit({ type: "permission_mode", mode: permissionMode });
    }).catch((error) => {
      emit({
        type: "permission_mode_error",
        mode: permissionMode,
        message: `Could not save permission mode: ${error.message}`,
      });
    });
  } else if (message.type === "cancel" && connection && sessionId) {
    connection.cancel({ sessionId }).catch(() => {});
  } else if (message.type === "close") {
    shutdown().finally(() => process.exit(0));
  }
});
input.on("close", () => shutdown());

child.on("exit", (code, signal) => {
  childExitResolve({ code, signal });
  if (!shuttingDown) {
    emit({ type: "fatal", message: `ACP agent exited (${signal || code})` });
    process.exit(code || 0);
  }
});
child.on("error", (error) => {
  emit({ type: "fatal", message: error.message });
  process.exit(1);
});

process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));

start().catch((error) => {
  emit({ type: "fatal", message: explainHarnessError(error, agentName) });
  child.kill("SIGTERM");
  process.exit(1);
});
