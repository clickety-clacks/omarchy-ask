// Transport policy shared with Yoohoo: agent-window-resolver's
// docs/transport-policy-v1.md. tests/transport-policy.test.mjs checks this
// module against that repository's vectors, which tests/fixtures carries
// verbatim. The resolver only observes reachability; this module chooses.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TRANSPORT_PREFERENCES = Object.freeze(["auto", "local", "et", "mosh", "ssh"]);
export const CAPABILITY_SCHEMA = "transport-capabilities.v1";
export const CAPABILITY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// A record where every transport is unknown (the probe could not run there)
// is kept briefly: long enough not to re-probe on every click.
export const UNKNOWN_CAPABILITY_MAX_AGE_MS = 24 * 3600 * 1000;
export const TRANSPORT_LAUNCH_SCRIPT = [
  "host=$1 remote=$2 port=$3 stale=$4 wrapped=$5 primary=$6",
  "if [ \"$primary\" = et ]; then",
  "  if [ -n \"$port\" ]; then et -p \"$port\" -c \"$wrapped\" -- \"$host\"; else et -c \"$wrapped\" -- \"$host\"; fi",
  "else",
  "  mosh -- \"$host\" sh -lc \"$remote\"",
  "fi",
  "status=$?",
  "[ \"$status\" -eq 0 ] && exit 0",
  "# A failed start on a reachable host means the recorded capability is stale.",
  "if [ -n \"$stale\" ] && ssh -o BatchMode=yes -o ConnectTimeout=5 -- \"$host\" true >/dev/null 2>&1; then",
  "  rm -f -- \"$stale\"",
  "fi",
  "exec ssh -tt -- \"$host\" \"$wrapped\"",
].join("\n");
const capabilityHost = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/;
const states = new Set(["available", "unavailable", "unknown"]);

export function transportPreference(value) {
  return TRANSPORT_PREFERENCES.includes(value) ? value : "auto";
}

export function chooseTransport(preference, targetIsLocal, clients, capabilities) {
  preference = transportPreference(preference);
  if (targetIsLocal) return { transport: "local", fallback: null };
  if (preference === "local") return { unavailable: "local_requires_local_target" };
  let transport;
  if (preference !== "auto") {
    if (!clients[preference]) return { unavailable: `${preference}_client_missing` };
    transport = preference;
  } else if (clients.et && capabilities?.et === "available") transport = "et";
  else if (clients.mosh && capabilities?.mosh !== "unavailable") transport = "mosh";
  else if (clients.ssh) transport = "ssh";
  else return { unavailable: "no_transport_client" };
  return { transport, fallback: transport !== "ssh" && clients.ssh ? "ssh" : null };
}

export function remoteShellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// The argv a terminal runs for a remote transport, with its ssh fallback.
export function transportLaunchArgv(transport, fallback, host, remote, etPort = null, staleFile = "") {
  const wrapped = `sh -lc ${remoteShellQuote(remote)}`;
  if (transport === "ssh") return ["ssh", "-tt", "--", host, wrapped];
  if (!fallback) {
    if (transport === "et") return ["et", ...(etPort ? ["-p", String(etPort)] : []), "-c", wrapped, "--", host];
    return ["mosh", "--", host, "sh", "-lc", remote];
  }
  // A login shell, so the launcher sees the PATH the client lookup saw.
  return ["sh", "-lc", TRANSPORT_LAUNCH_SCRIPT, "transport-launch", host, remote,
    etPort ? String(etPort) : "", staleFile, wrapped, transport];
}

export function capabilityDirectory(environment = process.env) {
  const base = environment.XDG_STATE_HOME || join(homedir(), ".local/state");
  return join(base, "omarchy-ask", "transport-capabilities");
}

function canonicalHost(host) {
  return String(host || "").toLowerCase().replace(/\.$/, "");
}

export function capabilityPath(directory, host) {
  if (!capabilityHost.test(String(host || ""))) return null;
  return join(directory, `${canonicalHost(host)}.json`);
}

// Recorded capability states for host, or null when it should be probed.
export function readCapabilities(directory, host, nowMs = Date.now()) {
  const path = capabilityPath(directory, host);
  if (!path) return null;
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const age = nowMs - record?.observedAtUnixMs;
  if (record?.schema !== CAPABILITY_SCHEMA || !Number.isSafeInteger(record.observedAtUnixMs)
      || !record.transports || typeof record.transports !== "object") return null;
  const result = {};
  for (const name of ["ssh", "et", "mosh"]) {
    const state = record.transports[name]?.state;
    result[name] = states.has(state) ? state : "unknown";
  }
  const limit = ["ssh", "et", "mosh"].every(name => result[name] === "unknown")
    ? UNKNOWN_CAPABILITY_MAX_AGE_MS : CAPABILITY_MAX_AGE_MS;
  if (!(age >= 0 && age <= limit)) return null;
  const port = record.transports.et?.port;
  result.etPort = Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
  return result;
}

// Persist an observation; an unreachable host never overwrites the record.
export function recordCapabilities(directory, host, response, nowMs = Date.now()) {
  const path = capabilityPath(directory, host);
  const transports = response?.transports;
  if (!path || !transports || !["complete", "partial"].includes(transports.state)) return false;
  const record = {
    schema: CAPABILITY_SCHEMA, host: canonicalHost(host), observedAtUnixMs: nowMs,
    resolverVersion: response.resolverVersion ?? null, transports,
  };
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(record)}\n`);
    renameSync(`${path}.tmp`, path);
    return true;
  } catch { return false; }
}
