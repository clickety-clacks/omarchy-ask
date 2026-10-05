#!/usr/bin/env node

// Ask's Agentd Hub subscriber and activation adapter. The shared
// agent-window-resolver ranks existing-window hints and separately verifies
// attachment targets; this process owns freshness checks and focus/attach.

import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { compositor } from "./compositor.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  ResolverClientError, canonicalTicks, createResolverClient,
} from "./agent-window-resolver.js";
import {
  capabilityDirectory, capabilityPath, chooseTransport, readCapabilities,
  recordCapabilities, transportLaunchArgv, transportPreference,
} from "./transport-policy.js";

const execFileAsync = promisify(execFile);
const reconnectDelays = [1000, 2000, 4000, 8000, 16000, 30000];
const safeHost = /^[A-Za-z0-9_.:@-]+$/;
// Session names are inserted into tmux's `session:window` target. A colon
// would change the target rather than merely name a session.
const safeSession = /^[^\u0000-\u001f\u007f:]+$/;
const safePane = /^%\d+$/;
const safeSocketName = /^[^/\u0000-\u001f\u007f]{1,128}$/;
const safeSocketPath = /^\/[^\u0000-\u001f\u007f]{1,4095}$/;
const addressPattern = /^0x[0-9a-f]+$/i;
const machinePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

let config = { host: "", port: 0, transport: "auto" };
let stream = null;
let generation = 0;
let reconnectTimer = null;
let reconnectIndex = 0;
let stopping = false;
let currentAgents = [];
let hubConnected = false;
let resolverClient = null;
let resolverSequence = 0;

function emit(value) {
  try { process.stdout.write(`${JSON.stringify(value)}\n`); } catch {}
}

function status(connected, error = "") {
  emit({ type: "status", connected: Boolean(connected), error: String(error || "") });
}

function closeStream() {
  if (stream) {
    try { stream.destroy(); } catch {}
    stream = null;
  }
}

function endpoint(path) {
  const rawHost = String(config.host || "").trim();
  const port = Number(config.port || 0);
  if (!rawHost || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const value = rawHost.includes("://")
    ? rawHost
    : `http://${rawHost}:${port}`;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
  // The UI stores an address and an explicit port. Apply that port even when
  // an operator pasted an http:// or https:// address.
  url.port = String(port);
  url.pathname = path;
  return url;
}

function sseFeed(response, token) {
  let buffer = "";
  let event = "message";
  let data = [];
  let eventBytes = 0;
  const flush = () => {
    if (!data.length) { event = "message"; eventBytes = 0; return; }
    const payload = data.join("\n");
    data = [];
    eventBytes = 0;
    const name = event;
    event = "message";
    if (name !== "snapshot" && name !== "message") return;
    try {
      const value = JSON.parse(payload);
      if (token === generation) acceptSnapshot(value);
    } catch (error) {
      if (token === generation) rejectSnapshot(`invalid snapshot: ${error.message}`);
    }
  };
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    if (token !== generation) return;
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      status(false, "hub event is too large");
      closeStream();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") { flush(); continue; }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const key = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (key === "event") event = value;
      else if (key === "data") {
        eventBytes += Buffer.byteLength(value, "utf8");
        if (eventBytes > 4 * 1024 * 1024) {
          status(false, "hub event is too large");
          closeStream();
          return;
        }
        data.push(value);
      }
    }
  });
  response.on("end", () => { if (token === generation) streamEnded("hub stream closed"); });
  response.on("error", (error) => { if (token === generation) streamEnded(error.message); });
}

function streamEnded(error) {
  stream = null;
  hubConnected = false;
  if (stopping || !endpoint("/events")) return;
  status(false, String(error || "hub stream closed"));
  scheduleReconnect();
}

function scheduleReconnect() {
  if (stopping || reconnectTimer || !endpoint("/events")) return;
  const delay = reconnectDelays[Math.min(reconnectIndex, reconnectDelays.length - 1)];
  reconnectIndex++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function connect() {
  if (stopping) return;
  const url = endpoint("/events");
  closeStream();
  if (!url) { status(false, "invalid hub address or port"); return; }
  const token = ++generation;
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  let handshakeTimer;
  const request = requester(url, {
    headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
  }, (response) => {
    clearTimeout(handshakeTimer);
    if (token !== generation) { response.resume(); return; }
    if (response.statusCode !== 200) {
      response.resume();
      streamEnded(`hub returned HTTP ${response.statusCode}`);
      return;
    }
    stream = response;
    // HTTP 200 only proves that an SSE stream exists. Keep activation gated
    // until a complete, validated snapshot arrives.
    status(false, "waiting for hub snapshot");
    sseFeed(response, token);
  });
  request.on("error", (error) => { if (token === generation) streamEnded(error.message); });
  handshakeTimer = setTimeout(() => request.destroy(new Error("hub connection timed out")), 10000);
  request.end();
}

function rejectSnapshot(message) {
  // A malformed complete frame is not a new roster and must not authorize
  // activation from the last-good frame. Keep that frame for truthful UI
  // display, but mark the source disconnected until a valid frame arrives.
  hubConnected = false;
  status(false, message);
  // A protocol-invalid frame makes this SSE connection untrustworthy. Do
  // not leave it quiet and connected forever; retain the last-good rows while
  // reconnecting with the normal backoff.
  closeStream();
  scheduleReconnect();
}

function normalizedSocket(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string")
    return safeSocketName.test(value) ? { kind: "name", value } : null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => key !== "kind" && key !== "value")) return null;
  const kind = String(value.kind || "");
  const socketValue = String(value.value || "");
  if (kind === "name" && safeSocketName.test(socketValue)) return { kind, value: socketValue };
  if (kind === "path" && safeSocketPath.test(socketValue)) return { kind, value: socketValue };
  return null;
}

function normalizedTmux(value) {
  if (value === undefined || value === null || (typeof value === "object" && !Object.keys(value).length))
    return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session = String(value.session || "");
  const windowIndex = String(value.windowIndex ?? "");
  const paneId = String(value.paneId || "");
  const socket = normalizedSocket(value.socket);
  if (!safeSession.test(session) || !/^(0|[1-9][0-9]{0,8})$/.test(windowIndex)
      || !safePane.test(paneId) || (value.socket !== undefined && value.socket !== null
        && value.socket !== "" && !socket)) return null;
  return { session, windowIndex, paneId, ...(socket ? { socket } : {}) };
}

function acceptSnapshot(value) {
  if (!value || value.type !== "snapshot" || value.schema !== "agentd-hub.snapshot.v1"
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.sources) || !Array.isArray(value.agents)
      || value.agents.length > 4096) {
    rejectSnapshot("unsupported agentd-hub snapshot");
    return;
  }
  const sourceStates = new Map();
  for (const source of value.sources) {
    const machine = String(source?.machine || "");
    const healthState = String(source?.health?.state || "");
    const scanState = String(source?.scan?.state || "complete");
    if (!source || typeof source !== "object" || !machine || machine.length > 255
        || /[\u0000-\u001f\u007f]/.test(machine) || !healthState
        || !["reporting", "not_reached", "no_agentd"].includes(healthState)
        || healthState.length > 64 || !scanState
        || !["complete", "degraded"].includes(scanState) || scanState.length > 64
        || sourceStates.has(machine)) {
      rejectSnapshot("invalid agentd-hub sources");
      return;
    }
    sourceStates.set(machine, { state: healthState, scan: scanState });
  }
  const agents = [];
  const identities = new Set();
  for (const agent of value.agents) {
    let ticks = "";
    try { ticks = canonicalTicks(agent?.id?.startTimeTicks, "agent.id.startTimeTicks"); } catch {}
    if (!agent || typeof agent !== "object" || !String(agent.machine || "")
        || !String(agent.instanceId || "") || String(agent.machine).length > 255
        || String(agent.instanceId).length > 512
        || !machinePattern.test(String(agent.machine))
        || /[\u0000-\u001f\u007f]/.test(String(agent.machine))
        || /[\u0000-\u001f\u007f]/.test(String(agent.instanceId)) || !agent.id
        || !Number.isSafeInteger(agent.id.pid) || agent.id.pid <= 0
        || agent.id.pid > 4194304 || !ticks
        || !sourceStates.has(String(agent.machine))
        || !agent.activity
        || !["active", "idle", "needs_attention", "unknown"].includes(String(agent.activity.state || "unknown"))
        || !agent.presence
        || !["present", "unknown"].includes(String(agent.presence.state || "unknown"))) {
      rejectSnapshot("invalid agentd-hub agent");
      return;
    }
    const tmux = normalizedTmux(agent.tmux);
    if (agent.tmux !== null && agent.tmux !== undefined
        && !(typeof agent.tmux === "object" && !Object.keys(agent.tmux).length) && !tmux) {
      rejectSnapshot("invalid agentd-hub tmux location");
      return;
    }
    const normalizedAgent = {
      ...agent,
      id: { ...agent.id, startTimeTicks: ticks },
      ...(tmux ? { tmux } : { tmux: null }),
      // Hub may retain an agent while its source is unreachable. Preserve
      // that fact separately from Agentd's last activity claim.
      hubSourceState: (sourceStates.get(String(agent.machine)) || {}).state || "unknown",
      hubScanState: (sourceStates.get(String(agent.machine)) || {}).scan || "unknown",
    };
    const identity = agentIdentity(normalizedAgent);
    if (identities.has(identity)) {
      rejectSnapshot("duplicate agentd-hub agent identity");
      return;
    }
    identities.add(identity);
    agents.push(normalizedAgent);
  }
  currentAgents = agents;
  hubConnected = true;
  // A live HTTP response is not proof that the Hub is producing valid
  // snapshots. Only a complete validated frame re-arms the fast reconnect.
  reconnectIndex = 0;
  emit({ type: "snapshot", revision: value.revision, agents });
}

function configure(next) {
  stopping = false;
  config = {
    host: String(next.host || "").trim(), port: Number(next.port || 0),
    transport: transportPreference(next.transport),
  };
  generation++;
  closeStream();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  currentAgents = [];
  hubConnected = false;
  // A blank address disables the optional integration, even if an old port
  // remains in settings while the user is editing the two fields separately.
  if (!config.host) { status(false, "disabled"); return; }
  if (!endpoint("/events")) { status(false, "invalid hub address or port"); return; }
  status(false, "connecting");
  reconnectIndex = 0;
  connect();
}

async function readStartTicks(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 4194304) return "";
  try {
    const stat = (await readFile(`/proc/${pid}/stat`)).toString("utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return "";
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return canonicalTicks(fields[19], `/proc/${pid}/stat startTimeTicks`);
  } catch { return ""; }
}

async function hyprClientsSnapshot() {
  try { return await compositor.clients(); } catch { return null; }
}

async function compositorWindows() {
  const clients = await hyprClientsSnapshot();
  if (!Array.isArray(clients))
    throw new ResolverClientError("resolver_window_snapshot_unavailable", "compositor window snapshot is unavailable");
  const mapped = clients.filter((client) => client?.mapped === true);
  const windows = await Promise.all(mapped.map(async (client) => {
    const stableId = String(client?.stableId || "");
    const address = String(client?.address || "").toLowerCase();
    const pid = Number(client?.pid || 0);
    if (!stableId || stableId.length > 256
        || /[\u0000-\u001f\u007f]/.test(stableId) || !/^0x[0-9a-f]{1,32}$/.test(address)
        || !Number.isSafeInteger(pid) || pid < 1 || pid > 4194304)
      throw new ResolverClientError("resolver_window_snapshot_unavailable", "mapped window identity is incomplete");
    const startTimeTicks = await readStartTicks(pid);
    if (!startTimeTicks)
      throw new ResolverClientError("resolver_window_snapshot_unavailable", "mapped window process identity is unreadable");
    const window = { stableId, address, pid, startTimeTicks };
    const title = String(client.title || "").slice(0, 512);
    if (!/[\u0000-\u001f\u007f]/.test(title)) window.title = title;
    const windowClass = String(client.class || "");
    if (windowClass.length <= 256 && !/[\u0000-\u001f\u007f]/.test(windowClass))
      window.class = windowClass;
    return window;
  }));
  const identities = new Set();
  for (const window of windows) {
    const key = JSON.stringify([window.stableId, window.address, window.pid, window.startTimeTicks]);
    if (identities.has(key))
      throw new ResolverClientError("resolver_window_snapshot_unavailable", "compositor returned a duplicate window identity");
    identities.add(key);
  }
  return windows;
}

// The final focus handoff requires the exact four-field candidate identity.
// A stable ID does not authorize following a window to a changed address.
function resolveFocusAddress(match, clients) {
  const window = match?.window || match;
  const stableId = String(window?.stableId || "");
  const address = String(window?.address || "");
  const expectedPid = Number(window?.pid || 0);
  if (!stableId || !addressPattern.test(address)
      || !Number.isSafeInteger(expectedPid) || expectedPid < 1) return "";
  const candidates = (Array.isArray(clients) ? clients : []).filter((client) =>
    client && client.mapped === true
      && String(client.stableId || "") === stableId
      && String(client.address || "").toLowerCase() === address.toLowerCase()
      && Number(client.pid || 0) === expectedPid);
  return candidates.length === 1 ? String(candidates[0].address) : "";
}

function sameWindowIdentity(left, right) {
  const a = left?.window || left;
  const b = right?.window || right;
  try {
    return Boolean(a && b && String(a.stableId || "") === String(b.stableId || "")
      && String(a.address || "").toLowerCase() === String(b.address || "").toLowerCase()
      && Number(a.pid || 0) === Number(b.pid || 0)
      && canonicalTicks(a.startTimeTicks) === canonicalTicks(b.startTimeTicks));
  } catch { return false; }
}

function agentIdentity(agent) {
  return JSON.stringify([
    String(agent.machine), String(agent.instanceId), agent.id.pid,
    canonicalTicks(agent.id.startTimeTicks, "agent.id.startTimeTicks"),
  ]);
}

function targetForAgent(agent) {
  const target = {
    identity: {
      machine: String(agent.machine),
      instanceId: String(agent.instanceId),
      pid: Number(agent.id.pid),
      startTimeTicks: canonicalTicks(agent.id.startTimeTicks, "agent.id.startTimeTicks"),
    },
  };
  const tmux = normalizedTmux(agent.tmux);
  if (tmux) target.tmux = tmux;
  return target;
}

function sameAgentTarget(left, right) {
  if (!left || !right) return false;
  try { return JSON.stringify(targetForAgent(left)) === JSON.stringify(targetForAgent(right)); }
  catch { return false; }
}

function localMachineMatches(agentMachine) {
  const local = String(hostname() || "").toLowerCase().replace(/\.$/, "");
  const target = String(agentMachine || "").toLowerCase().replace(/\.$/, "");
  return Boolean(local && target
    && (local === target || local.split(".")[0] === target || target.split(".")[0] === local));
}

function resolver() {
  if (!resolverClient) resolverClient = createResolverClient();
  return resolverClient;
}

function resolverRequest(operation, agent, windows, extras = {}) {
  resolverSequence = (resolverSequence + 1) % 1000000000;
  return {
    schema: "agent-window-resolver.request.v1",
    requestId: `ask-${process.pid}-${Date.now()}-${resolverSequence}`,
    operation,
    target: { ...targetForAgent(agent), ...(operation === "match" && agent.name
      ? { name: String(agent.name) } : {}) },
    local: { machine: String(hostname() || "") },
    windows,
    ...extras,
    limits: {
      deadlineMs: 19000,
      maxRequestBytes: 262144,
      maxStdoutBytes: 1048576,
      maxStderrBytes: 16384,
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function tmuxArgs(location, operation, ...args) {
  const socket = normalizedSocket(location?.socket);
  const selector = socket?.kind === "name" ? ["-L", socket.value]
    : (socket?.kind === "path" ? ["-S", socket.value] : []);
  return ["tmux", ...selector, operation, ...args];
}

function tmuxAttachCommand(agent) {
  const location = agent.tmux || {};
  const session = String(location.session || "");
  const windowIndex = location.windowIndex === undefined || location.windowIndex === null
    ? "" : String(location.windowIndex);
  const paneId = String(location.paneId || "");
  const commands = [];
  if (/^\d+$/.test(windowIndex) && safePane.test(paneId)) {
    // A pane-qualified attach selects the exact target in one operation. Do
    // not run select-window/select-pane as a separate prelude: if terminal
    // startup fails those commands would still mutate the shared session.
    commands.push(tmuxArgs(location, "attach-session", "-t", `=${session}:${windowIndex}.${paneId}`));
  } else commands.push(tmuxArgs(location, "attach-session", "-t", `=${session}`));
  return commands.map((command) => command.map(shellQuote).join(" ")).join(" && ");
}

function commandLine(args) {
  return args.map(shellQuote).join(" ");
}

// The shared resolver verifies the remote identity before a launch. et and
// mosh need a TTY, so they start inside the terminal; transportLaunchArgv's
// launcher falls back to ssh only when they fail to start, never after a
// normal session exit.

async function which(command) {
  try { const result = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`], { timeout: 500 }); return result.stdout.trim(); }
  catch { return ""; }
}

// One login shell answers for all three clients, with more time than a single
// lookup: a slow profile must not make a missing ssh a new way to fail.
async function transportClients() {
  const names = ["et", "mosh", "ssh"];
  try {
    const script = names.map(name => `command -v ${name} >/dev/null 2>&1 && echo ${name}`).join("; ");
    const { stdout } = await execFileAsync("sh", ["-lc", `${script}; true`], { timeout: 3000 });
    const found = new Set(stdout.split(/\s+/));
    return Object.fromEntries(names.map(name => [name, found.has(name)]));
  } catch {
    // If the profile cannot answer, assume the clients the old ladder assumed.
    return { et: false, mosh: Boolean(await which("mosh")), ssh: true };
  }
}

async function spawnDetached(command, args) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("spawn", () => finish(true));
      child.once("error", () => finish(false));
      child.unref();
    } catch { finish(false); }
  });
}

async function showNotice(agent, reason) {
  const terminal = await which("ghostty") || await which("xdg-terminal-exec");
  if (!terminal) return false;
  const machine = String(agent.machine || "unknown");
  const title = String(agent.name || agent.harness || "agent");
  const message = reason === "resolver_dependency_missing"
    ? "Ask cannot activate agent windows because its internal Python resolver is unavailable."
    : reason === "resolver_dependency_incompatible"
      ? "Ask cannot activate agent windows because its bundled resolver returned an incompatible response."
      : reason === "resolver_dependency_unavailable"
        ? "Ask cannot activate agent windows because its internal Python resolver failed."
      : reason === "resolver_too_old"
        ? "Ask cannot activate agent windows because its bundled resolver is older than this version of Ask expects."
      : reason === "resolver_window_snapshot_unavailable"
        ? "Ask cannot activate this agent because the current desktop window snapshot is unavailable or incomplete."
      : reason === "no_transport_client"
        ? `Agent ${title} on ${machine} cannot be reached: none of et, mosh or ssh is installed here.`
      : /^(et|mosh|ssh)_client_missing$/.test(reason)
        ? `Ask is set to connect with ${reason.split("_")[0]}, but it is not installed here.`
      : reason === "local_requires_local_target"
        ? `Ask is set to transport "local", but agent ${title} runs on ${machine}.`
      : reason === "no_tmux"
    ? `Agent ${title} on ${machine} cannot be attached because it is not running in a tmux session.`
    : `Agent ${title} on ${machine} could not be connected. The network or tmux session may be unavailable.`;
  const command = `printf '%s\\n\\n' ${shellQuote(message)}; printf '%s' 'Press Enter to close…'; read -r`;
  return spawnDetached(terminal, ["-e", "sh", "-lc", command]);
}

async function focus(address) {
  if (!addressPattern.test(String(address || ""))) return false;
  try { return await compositor.presentWindow(address); } catch { return false; }
}

const activeWindowAddress = () => compositor.activeWindowAddress();

function chooseExistingCandidate(candidates, clients, activeAddress) {
  const eligible = candidates.filter(candidate => resolveFocusAddress(candidate, clients));
  const history = candidate => {
    const client = clients.find(item => String(item.stableId) === candidate.window.stableId);
    const value = client?.focusHistoryID;
    return Number.isInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
  };
  return eligible.sort((a, b) => b.match.score - a.match.score
    || Number(b.window.address === activeAddress) - Number(a.window.address === activeAddress)
    || history(a) - history(b)
    || a.window.stableId.localeCompare(b.window.stableId)
    || a.window.address.localeCompare(b.window.address))[0];
}

async function activate(id, dependencies = {}) {
  const identity = String(id || "");
  const lookupAgent = dependencies.lookupAgent
    || ((value) => currentAgents.find((candidate) => agentIdentity(candidate) === value));
  const isConnected = dependencies.isHubConnected || (() => hubConnected);
  const collectWindows = dependencies.compositorWindows || compositorWindows;
  const collectClients = dependencies.hyprClientsSnapshot || hyprClientsSnapshot;
  const collectTicks = dependencies.readStartTicks || readStartTicks;
  const dispatchFocus = dependencies.focus || focus;
  const collectActiveAddress = dependencies.activeWindowAddress || activeWindowAddress;
  const launchDetached = dependencies.spawnDetached || spawnDetached;
  const findExecutable = dependencies.which || which;
  const capabilities = dependencies.capabilityDirectory ?? capabilityDirectory();
  const preference = dependencies.transport ?? config.transport;
  const notify = dependencies.showNotice || showNotice;
  const output = dependencies.emit || emit;
  const reject = async (agent, reason, noticeReason = "connection_failed") => {
    if (agent) await notify(agent, noticeReason);
    output({ type: "activation", id, ok: false, reason });
  };
  let agent = lookupAgent(identity);
  if (!agent) return output({ type: "activation", id, ok: false, reason: "agent_not_found" });
  let resolverApi;
  try { resolverApi = dependencies.resolver || resolver(); }
  catch (error) {
    const reason = error instanceof ResolverClientError ? error.code : "resolver_failed";
    return reject(agent, reason, reason);
  }

  let resolved;
  try {
    const windows = await collectWindows();
    resolved = await resolverApi.request(resolverRequest("match", agent, windows));
  } catch (error) {
    const reason = error instanceof ResolverClientError ? error.code : "resolver_failed";
    return reject(agent, reason, reason);
  }

  const postResolveAgent = lookupAgent(identity);
  if (!postResolveAgent || !sameAgentTarget(agent, postResolveAgent))
    return reject(agent, "connection_changed");
  agent = postResolveAgent;

  if (resolved.status === "matched") {
    const selectionClients = await collectClients();
    if (!Array.isArray(selectionClients)) return reject(agent, "resolver_window_snapshot_unavailable");
    const prior = chooseExistingCandidate(resolved.candidates, selectionClients, await collectActiveAddress());
    if (!prior) return reject(agent, "connection_changed");
    let revalidated;
    try {
      revalidated = await resolverApi.request(resolverRequest("match", agent, await collectWindows()));
    } catch (error) {
      const reason = error instanceof ResolverClientError ? error.code : "resolver_failed";
      return reject(agent, reason, reason);
    }
    const postRevalidateAgent = lookupAgent(identity);
    if (!postRevalidateAgent || !sameAgentTarget(agent, postRevalidateAgent)
        || revalidated.status !== "matched"
        || !revalidated.candidates.some(candidate => sameWindowIdentity(prior, candidate)))
      return reject(agent, "connection_changed");
    const candidate = revalidated.candidates.find(candidate => sameWindowIdentity(prior, candidate));
    const finalClients = await collectClients();
    if (!Array.isArray(finalClients))
      return reject(postRevalidateAgent, "resolver_window_snapshot_unavailable",
        "resolver_window_snapshot_unavailable");
    const freshAddress = resolveFocusAddress(candidate, finalClients);
    const finalTicks = freshAddress ? await collectTicks(candidate.window.pid) : "";
    const finalAgent = lookupAgent(identity);
    if (freshAddress && finalAgent && sameAgentTarget(postRevalidateAgent, finalAgent)
        && finalTicks === canonicalTicks(candidate.window.startTimeTicks)
        && await dispatchFocus(freshAddress))
      return output({ type: "activation", id, ok: true, existing: true });
    return reject(finalAgent || agent, "connection_changed");
  }

  // Ambiguity or a failed live resolver probe is not permission to create a
  // duplicate connection. Only a completed zero-candidate result proceeds to
  // the separately verified attach path.
  if (resolved.status !== "unresolved")
    return reject(agent, resolved.status === "ambiguous" ? "window_ambiguous" : "resolver_unavailable");
  if (!resolved.reasons?.some(reason => reason.code === "candidate_count")
      || resolved.reasons.some(reason => reason.code === "local_collection_incomplete"))
    return reject(agent, "resolver_window_snapshot_unavailable", "resolver_window_snapshot_unavailable");

  // Source health is an adapter policy for new mutation, not resolver proof.
  if (!isConnected() || agent.hubSourceState !== "reporting"
      || agent.presence?.state !== "present")
    return reject(agent, "connection_failed");

  const location = normalizedTmux(agent.tmux);
  if (!location) return reject(agent, "no_tmux", "no_tmux");
  if (!safeHost.test(String(agent.machine || "")))
    return reject(agent, "invalid_machine");

  const local = localMachineMatches(agent.machine);
  let recorded = local ? null : readCapabilities(capabilities, agent.machine);
  let verified;
  try {
    verified = await resolverApi.request(resolverRequest("verify-target", agent, [],
      local || recorded ? {} : { probeTransports: true }));
  } catch (error) {
    const reason = error instanceof ResolverClientError ? error.code : "resolver_failed";
    return reject(agent, reason, reason);
  }
  if (verified.status !== "verified") return reject(agent, "target_unavailable");
  // Discovery informs auto only; without a usable observation the launch
  // proceeds exactly as mosh-first did.
  if (!local && recordCapabilities(capabilities, agent.machine, verified))
    recorded = readCapabilities(capabilities, agent.machine);
  const current = lookupAgent(identity);
  if (!current || !sameAgentTarget(agent, current) || !isConnected()
      || current.hubSourceState !== "reporting" || current.presence?.state !== "present")
    return reject(current || agent, "connection_changed");
  const verifiedLocation = verified.verifiedTarget.location;
  if (verifiedLocation.kind !== "tmux") return reject(current, "target_unavailable");
  const attachLocation = verifiedLocation.tmux;

  const terminal = await findExecutable("ghostty") || await findExecutable("xdg-terminal-exec");
  if (!terminal) return reject(current, "terminal_unavailable");
  const clients = local ? {} : dependencies.which
    ? Object.fromEntries(await Promise.all(["et", "mosh", "ssh"]
      .map(async name => [name, Boolean(await findExecutable(name))])))
    : await transportClients();
  const choice = chooseTransport(preference, local, clients, recorded);
  if (choice.unavailable) return reject(current, choice.unavailable, choice.unavailable);
  // Recheck the exact roster target after all asynchronous discovery and
  // immediately before constructing and dispatching the mutating launch.
  const finalAgent = lookupAgent(identity);
  if (!finalAgent || !sameAgentTarget(current, finalAgent) || !isConnected()
      || finalAgent.hubSourceState !== "reporting" || finalAgent.presence?.state !== "present")
    return reject(finalAgent || current, "connection_changed");
  const { transport } = choice;
  if (!local && String(finalAgent.machine).startsWith("-")) return reject(finalAgent, "invalid_machine");
  const transportArgs = local
    ? ["-e", "sh", "-lc", tmuxAttachCommand({ tmux: attachLocation })]
    : ["-e", ...transportLaunchArgv(transport, choice.fallback, finalAgent.machine,
      tmuxAttachCommand({ tmux: attachLocation }), recorded?.etPort ?? null,
      capabilityPath(capabilities, finalAgent.machine) || "")];
  if (await launchDetached(terminal, transportArgs))
    return output({ type: "activation", id, ok: true, existing: false, transport });
  return reject(finalAgent, "launch_failed");
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.op === "configure") configure(message);
  else if (message.op === "activate") activate(message.id).catch(() => emit({ type: "activation", id: message.id, ok: false, reason: "activation_failed" }));
});

// These are the adapter's pure policy and command-building seams. Tests call
// the same activation path with controlled read-only and side-effect deps.
export {
  activate, agentIdentity, resolveFocusAddress, sameAgentTarget,
  sameWindowIdentity, tmuxAttachCommand,
  chooseExistingCandidate,
};

process.on("SIGTERM", () => { stopping = true; generation++; closeStream(); if (reconnectTimer) clearTimeout(reconnectTimer); process.exit(0); });
process.on("SIGINT", () => { stopping = true; generation++; closeStream(); process.exit(0); });
