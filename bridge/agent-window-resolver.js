import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUEST_SCHEMA = "agent-window-resolver.request.v1";
const RESPONSE_SCHEMA = "agent-window-resolver.response.v1";
const BUNDLED_MODULE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const BUNDLED_RESOLVER_ARGV = Object.freeze([
  "python3", "-B", "-S", "-E", "-m", "agent_window_resolver",
]);
const MAX_TICKS = "18446744073709551615";
const operations = new Set(["resolve", "revalidate", "verify-target", "match"]);
const relations = new Set(["visible_exact", "linked_client"]);
const statuses = new Set(["matched", "ambiguous", "unresolved", "unreachable", "invalid", "verified"]);
const evidenceSources = new Set([
  "caller", "compositor", "proc", "argv", "tmux", "transport", "socket",
  "ssh_environment", "roster",
]);
const reasonSources = new Set([...evidenceSources, "request", "dependency", "internal"]);
const evidenceResults = new Set(["supports", "contradicts", "unavailable", "informational"]);
const controlCharacters = /[\u0000-\u001f\u007f]/;

class ResolverClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ResolverClientError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new ResolverClientError(code, message, details);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("resolver_response_incompatible", `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, required, label) {
  const item = record(value, label);
  for (const key of required)
    if (!Object.prototype.hasOwnProperty.call(item, key))
      fail("resolver_response_incompatible", `${label}.${key} is required`);
  for (const key of Object.keys(item))
    if (!allowed.has(key))
      fail("resolver_response_incompatible", `${label}.${key} is unsupported`);
  return item;
}

function boundedText(value, label, minimum, maximum, pattern = null) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum
      || controlCharacters.test(value) || (pattern && !pattern.test(value)))
    fail("resolver_response_incompatible", `${label} is invalid`);
  return value;
}

function canonicalTicks(value, label = "startTimeTicks") {
  let text;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) text = String(value);
  else fail("resolver_identity_invalid", `${label} must be a canonical decimal string or safe integer`);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)
      || (text.length === MAX_TICKS.length && text > MAX_TICKS))
    fail("resolver_identity_invalid", `${label} is outside unsigned 64-bit canonical form`);
  return text;
}

function responseTicks(value, label) {
  if (typeof value !== "string")
    fail("resolver_response_incompatible", `${label} must be a canonical decimal string`);
  return canonicalTicks(value, label);
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    fail("resolver_response_incompatible", `${label} is invalid`);
  return value;
}

function validateIdentity(value, label) {
  const item = exactKeys(value,
    new Set(["machine", "instanceId", "pid", "startTimeTicks"]),
    new Set(["machine", "instanceId", "pid", "startTimeTicks"]), label);
  boundedText(item.machine, `${label}.machine`, 1, 255, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
  boundedText(item.instanceId, `${label}.instanceId`, 1, 512);
  positiveInteger(item.pid, `${label}.pid`, 4194304);
  responseTicks(item.startTimeTicks, `${label}.startTimeTicks`);
  return item;
}

function validateOptionalName(value, label) {
  if (value !== undefined) boundedText(value, label, 1, 512);
}

function validateSocket(value, label) {
  const item = exactKeys(value, new Set(["kind", "value"]), new Set(["kind", "value"]), label);
  if (item.kind === "name")
    boundedText(item.value, `${label}.value`, 1, 128, /^[^/\u0000-\u001f\u007f]+$/);
  else if (item.kind === "path")
    boundedText(item.value, `${label}.value`, 2, 4096, /^\/[^\u0000-\u001f\u007f]*$/);
  else fail("resolver_response_incompatible", `${label}.kind is invalid`);
  return item;
}

function validateTmux(value, label) {
  const item = exactKeys(value,
    new Set(["session", "windowIndex", "paneId", "socket"]),
    new Set(["session", "windowIndex", "paneId"]), label);
  boundedText(item.session, `${label}.session`, 1, 256);
  if (item.session.includes(":")) fail("resolver_response_incompatible", `${label}.session contains ':'`);
  boundedText(item.windowIndex, `${label}.windowIndex`, 1, 9, /^(0|[1-9][0-9]{0,8})$/);
  boundedText(item.paneId, `${label}.paneId`, 2, 13, /^%[0-9]{1,12}$/);
  if (item.socket !== undefined) validateSocket(item.socket, `${label}.socket`);
  return item;
}

function validateWindow(value, label) {
  const item = exactKeys(value,
    new Set(["stableId", "address", "pid", "startTimeTicks", "class", "title"]),
    new Set(["stableId", "address", "pid", "startTimeTicks"]), label);
  boundedText(item.stableId, `${label}.stableId`, 1, 256);
  boundedText(item.address, `${label}.address`, 3, 34, /^0x[0-9a-f]{1,32}$/);
  positiveInteger(item.pid, `${label}.pid`, 4194304);
  responseTicks(item.startTimeTicks, `${label}.startTimeTicks`);
  if (item.class !== undefined) boundedText(item.class, `${label}.class`, 0, 256);
  if (item.title !== undefined) boundedText(item.title, `${label}.title`, 0, 512);
  return item;
}

function validateLocation(value, label) {
  const item = record(value, label);
  if (item.kind === "local")
    return exactKeys(item, new Set(["kind"]), new Set(["kind"]), label);
  if (item.kind === "tmux") {
    exactKeys(item, new Set(["kind", "tmux"]), new Set(["kind", "tmux"]), label);
    validateTmux(item.tmux, `${label}.tmux`);
    return item;
  }
  fail("resolver_response_incompatible", `${label}.kind is invalid`);
}

function validateEndpoint(value, label) {
  const item = exactKeys(value,
    new Set(["protocol", "addressFamily", "local", "remote"]),
    new Set(["protocol", "addressFamily", "local", "remote"]), label);
  if (!["tcp", "udp"].includes(item.protocol) || !["ipv4", "ipv6"].includes(item.addressFamily))
    fail("resolver_response_incompatible", `${label} protocol or family is invalid`);
  for (const side of ["local", "remote"]) {
    const endpoint = exactKeys(item[side], new Set(["address", "port"]),
      new Set(["address", "port"]), `${label}.${side}`);
    if (typeof endpoint.address !== "string" || endpoint.address.length < 2 || endpoint.address.length > 128)
      fail("resolver_response_incompatible", `${label}.${side}.address is invalid`);
    positiveInteger(endpoint.port, `${label}.${side}.port`, 65535);
  }
}

function validateEvidenceValue(value, label) {
  if (typeof value === "string") {
    if (value.length > 512 || controlCharacters.test(value))
      fail("resolver_response_incompatible", `${label} is invalid`);
    return;
  }
  if (typeof value === "boolean" || (Number.isSafeInteger(value) && typeof value === "number")) return;
  if (value?.kind === "name" || value?.kind === "path") return void validateSocket(value, label);
  if (value?.protocol !== undefined) return void validateEndpoint(value, label);
  fail("resolver_response_incompatible", `${label} is invalid`);
}

function validateEvidence(value, label) {
  const item = exactKeys(value, new Set(["code", "source", "result", "details"]),
    new Set(["code", "source", "result"]), label);
  boundedText(item.code, `${label}.code`, 1, 64, /^[a-z][a-z0-9_]{0,63}$/);
  if (!evidenceSources.has(item.source) || !evidenceResults.has(item.result))
    fail("resolver_response_incompatible", `${label} source or result is invalid`);
  if (item.details !== undefined) {
    const details = record(item.details, `${label}.details`);
    if (Object.keys(details).length > 16) fail("resolver_response_incompatible", `${label}.details is too large`);
    for (const [key, detail] of Object.entries(details)) {
      if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key))
        fail("resolver_response_incompatible", `${label}.details key is invalid`);
      validateEvidenceValue(detail, `${label}.details.${key}`);
    }
  }
}

function validateReason(value, label) {
  const item = exactKeys(value, new Set(["code", "source", "message", "retryable"]),
    new Set(["code", "source", "message", "retryable"]), label);
  boundedText(item.code, `${label}.code`, 1, 64, /^[a-z][a-z0-9_]{0,63}$/);
  if (!reasonSources.has(item.source) || typeof item.retryable !== "boolean")
    fail("resolver_response_incompatible", `${label} source or retryability is invalid`);
  if (typeof item.message !== "string" || item.message.length < 1 || item.message.length > 512)
    fail("resolver_response_incompatible", `${label}.message is invalid`);
}

function validateProof(value, label) {
  const item = exactKeys(value, new Set(["state", "relation", "evidence"]),
    new Set(["state", "relation", "evidence"]), label);
  if (!["complete", "partial"].includes(item.state)) fail("resolver_response_incompatible", `${label}.state is invalid`);
  if (item.state === "complete" ? !relations.has(item.relation) : item.relation !== "partial")
    fail("resolver_response_incompatible", `${label}.relation is invalid`);
  if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 128)
    fail("resolver_response_incompatible", `${label}.evidence is invalid`);
  item.evidence.forEach((entry, index) => validateEvidence(entry, `${label}.evidence[${index}]`));
}

function validateTargetResult(value, label) {
  const item = exactKeys(value, new Set(["identity", "location"]),
    new Set(["identity", "location"]), label);
  validateIdentity(item.identity, `${label}.identity`);
  validateLocation(item.location, `${label}.location`);
}

function validateMatch(value, label) {
  const item = exactKeys(value,
    new Set(["confidence", "score", "evidence", "uncertainty"]),
    new Set(["confidence", "score", "evidence", "uncertainty"]), label);
  if (!["high", "medium", "low"].includes(item.confidence)
      || !Number.isSafeInteger(item.score) || item.score < 0 || item.score > 100)
    fail("resolver_response_incompatible", `${label} confidence or score is invalid`);
  if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 128
      || !Array.isArray(item.uncertainty) || item.uncertainty.length > 128)
    fail("resolver_response_incompatible", `${label} collections are invalid`);
  item.evidence.forEach((entry, index) => validateEvidence(entry, `${label}.evidence[${index}]`));
  item.uncertainty.forEach((entry, index) => validateReason(entry, `${label}.uncertainty[${index}]`));
}

function validateCandidate(value, label, operation) {
  const detail = operation === "match" ? "match" : "proof";
  const item = exactKeys(value, new Set(["window", "target", detail]),
    new Set(["window", "target", detail]), label);
  validateWindow(item.window, `${label}.window`);
  validateTargetResult(item.target, `${label}.target`);
  if (operation === "match") validateMatch(item.match, `${label}.match`);
  else validateProof(item.proof, `${label}.proof`);
}

function canonicalMachine(value) {
  return String(value).toLowerCase().replace(/\.$/, "");
}

function sameIdentity(left, right) {
  return canonicalMachine(left.machine) === canonicalMachine(right.machine)
    && left.instanceId === right.instanceId && left.pid === right.pid
    && canonicalTicks(left.startTimeTicks) === canonicalTicks(right.startTimeTicks);
}

function sameWindow(left, right) {
  return left.stableId === right.stableId && left.address === right.address
    && left.pid === right.pid
    && canonicalTicks(left.startTimeTicks) === canonicalTicks(right.startTimeTicks);
}

function targetLocationMatches(target, result, operation) {
  if (!target.tmux) return result.kind === "local";
  if (result.kind !== "tmux") return false;
  const left = target.tmux;
  const right = result.tmux;
  if (left.session !== right.session || left.windowIndex !== right.windowIndex || left.paneId !== right.paneId)
    return false;
  if (left.socket) return JSON.stringify(left.socket) === JSON.stringify(right.socket);
  if (operation === "match") return right.socket === undefined;
  return right.socket?.kind === "path";
}

function validateTransports(value) {
  const item = exactKeys(value, new Set(["state", "ssh", "et", "mosh"]),
    new Set(["state", "ssh", "et", "mosh"]), "response.transports");
  if (!["complete", "partial", "unreachable", "not_applicable"].includes(item.state))
    fail("resolver_response_incompatible", "response.transports.state is invalid");
  for (const name of ["ssh", "et", "mosh"]) {
    const entry = exactKeys(item[name], new Set(["state", "code", "port"]),
      new Set(["state", "code"]), `response.transports.${name}`);
    if (!["available", "unavailable", "unknown"].includes(entry.state))
      fail("resolver_response_incompatible", `response.transports.${name}.state is invalid`);
    boundedText(entry.code, `response.transports.${name}.code`, 1, 64, /^[a-z][a-z0-9_]{0,63}$/);
    if (entry.port !== undefined) positiveInteger(entry.port, `response.transports.${name}.port`, 65535);
  }
}

function validateResolverResponse(value, request) {
  // Every response from library 0.2.0 on names its version. A copy without it
  // predates fields Ask sends (probeTransports), so say so instead of
  // reporting its rejection as an invalid request.
  if (value && typeof value === "object" && !Array.isArray(value) && value.resolverVersion === undefined)
    fail("resolver_too_old", "Ask's internal resolver predates version 0.2.0");
  const item = exactKeys(value,
    new Set(["schema", "resolverVersion", "requestId", "operation", "requestedRelation", "status",
      "candidates", "verifiedTarget", "evidence", "reasons", "transports"]),
    new Set(["schema", "resolverVersion", "requestId", "operation", "status", "candidates", "evidence", "reasons"]),
    "response");
  if (item.schema !== RESPONSE_SCHEMA)
    fail("resolver_dependency_incompatible", "agent-window-resolver response schema is incompatible");
  boundedText(item.resolverVersion, "response.resolverVersion", 5, 32, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  if (item.transports !== undefined) {
    if (item.status !== "verified" || request.probeTransports !== true)
      fail("resolver_response_incompatible", "transports were not requested");
    validateTransports(item.transports);
  }
  if (item.requestId !== request.requestId || item.operation !== request.operation
      || !operations.has(item.operation) || !statuses.has(item.status))
    fail("resolver_response_incompatible", "resolver response requestId, operation, or status is incompatible");
  if (!Array.isArray(item.candidates) || item.candidates.length > 4096
      || !Array.isArray(item.evidence) || item.evidence.length > 256
      || !Array.isArray(item.reasons) || item.reasons.length > 128)
    fail("resolver_response_incompatible", "resolver response collections are invalid");
  item.candidates.forEach((entry, index) =>
    validateCandidate(entry, `response.candidates[${index}]`, request.operation));
  item.evidence.forEach((entry, index) => validateEvidence(entry, `response.evidence[${index}]`));
  item.reasons.forEach((entry, index) => validateReason(entry, `response.reasons[${index}]`));
  if (request.operation === "verify-target" || request.operation === "match") {
    if (item.requestedRelation !== undefined)
      fail("resolver_response_incompatible", `${request.operation} response has a relation`);
  } else if (item.status !== "invalid" && item.requestedRelation !== request.requestedRelation) {
    fail("resolver_response_incompatible", "resolver response relation does not match the request");
  } else if (item.requestedRelation !== undefined && item.requestedRelation !== request.requestedRelation) {
    fail("resolver_response_incompatible", "resolver response relation does not match the request");
  }
  if (item.status === "matched") {
    const validCount = item.operation === "match"
      ? item.candidates.length >= 1 : item.candidates.length === 1;
    if (!new Set(["resolve", "revalidate", "match"]).has(item.operation) || !validCount || item.reasons.length)
      fail("resolver_response_incompatible", "matched response cardinality is invalid");
  } else if (item.status === "ambiguous") {
    if (item.operation !== "resolve" || item.candidates.length < 2 || !item.reasons.length)
      fail("resolver_response_incompatible", "ambiguous response cardinality is invalid");
  } else if (["unresolved", "unreachable", "invalid"].includes(item.status)) {
    if (item.candidates.length || !item.reasons.length || item.verifiedTarget !== undefined)
      fail("resolver_response_incompatible", `${item.status} response cardinality is invalid`);
  } else if (item.status === "verified") {
    if (item.operation !== "verify-target" || item.candidates.length || item.reasons.length || !item.verifiedTarget)
      fail("resolver_response_incompatible", "verified response cardinality is invalid");
  }
  if (request.operation === "match"
      && !["matched", "unresolved", "unreachable", "invalid"].includes(item.status))
    fail("resolver_response_incompatible", "match response status is invalid");
  if (item.status !== "verified" && item.verifiedTarget !== undefined)
    fail("resolver_response_incompatible", "verifiedTarget is forbidden for this status");
  const candidateIdentities = new Set();
  for (const candidate of item.candidates) {
    const candidateKey = JSON.stringify([
      candidate.window.stableId, candidate.window.address,
      candidate.window.pid, candidate.window.startTimeTicks,
    ]);
    if (candidateIdentities.has(candidateKey))
      fail("resolver_response_incompatible", "resolver response contains duplicate candidate identities");
    candidateIdentities.add(candidateKey);
    const requestedWindow = request.windows.find((window) => sameWindow(window, candidate.window));
    if (!sameIdentity(candidate.target.identity, request.target.identity)
        || !targetLocationMatches(request.target, candidate.target.location, request.operation)
        || !requestedWindow)
      fail("resolver_response_incompatible", "candidate proof or full identity does not match the request");
    if (request.operation !== "match" && (candidate.proof.state !== "complete"
        || candidate.proof.relation !== request.requestedRelation)) {
      fail("resolver_response_incompatible", "candidate proof does not authorize the requested relation");
    }
    if (request.operation === "revalidate" && !sameWindow(candidate.window, request.prior.window))
      fail("resolver_response_incompatible", "revalidate substituted a different window");
  }
  if (item.status === "verified") {
    const verified = exactKeys(item.verifiedTarget, new Set(["identity", "location", "evidence"]),
      new Set(["identity", "location", "evidence"]), "response.verifiedTarget");
    validateIdentity(verified.identity, "response.verifiedTarget.identity");
    validateLocation(verified.location, "response.verifiedTarget.location");
    if (!Array.isArray(verified.evidence) || verified.evidence.length < 1 || verified.evidence.length > 128)
      fail("resolver_response_incompatible", "verifiedTarget evidence is invalid");
    verified.evidence.forEach((entry, index) => validateEvidence(entry, `response.verifiedTarget.evidence[${index}]`));
    if (!sameIdentity(verified.identity, request.target.identity)
        || !targetLocationMatches(request.target, verified.location, request.operation))
      fail("resolver_response_incompatible", "verified target full identity does not match the request");
  }
  return item;
}

function validateMatchRequest(value) {
  exactKeys(value,
    new Set(["schema", "requestId", "operation", "target", "local", "windows", "limits"]),
    new Set(["schema", "requestId", "operation", "target", "local", "windows"]), "request");
  if (value.schema !== REQUEST_SCHEMA || value.operation !== "match")
    fail("resolver_request_invalid", "match request schema or operation is invalid");
  boundedText(value.requestId, "request.requestId", 1, 128);
  const target = exactKeys(value.target, new Set(["identity", "tmux", "name"]),
    new Set(["identity"]), "request.target");
  validateIdentity(target.identity, "request.target.identity");
  if (target.tmux !== undefined) validateTmux(target.tmux, "request.target.tmux");
  validateOptionalName(target.name, "request.target.name");
  const local = exactKeys(value.local, new Set(["machine"]), new Set(["machine"]), "request.local");
  boundedText(local.machine, "request.local.machine", 1, 255, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
  if (!Array.isArray(value.windows) || value.windows.length > 4096)
    fail("resolver_request_invalid", "request.windows must be a bounded array");
  const identities = new Set();
  value.windows.forEach((window, index) => {
    validateWindow(window, `request.windows[${index}]`);
    const key = JSON.stringify([window.stableId, window.address, window.pid, window.startTimeTicks]);
    if (identities.has(key)) fail("resolver_request_invalid", "request.windows contains duplicate identities");
    identities.add(key);
  });
}

function expectedExitCode(response) {
  const first = response.reasons[0] || {};
  if (first.code === "deadline_exceeded") return 5;
  if (["dependency_missing", "dependency_incompatible"].includes(first.code)) return 3;
  if (response.status === "invalid")
    return first.source === "internal" || first.code === "output_limit_exceeded" ? 4 : 2;
  if (response.status === "unreachable" && first.source === "internal") return 4;
  return 0;
}

function effectiveLimits(value) {
  const defaults = {
    deadlineMs: 20000, maxRequestBytes: 262144,
    maxStdoutBytes: 1048576, maxStderrBytes: 16384,
  };
  if (value === undefined) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("resolver_request_invalid", "resolver limits must be a non-empty object");
  const keys = Object.keys(value);
  const allowed = new Set(Object.keys(defaults));
  if (!keys.length || keys.some((key) => !allowed.has(key)))
    fail("resolver_request_invalid", "resolver limits contain unsupported fields");
  const ranges = {
    deadlineMs: [1, 20000], maxRequestBytes: [1024, 262144],
    maxStdoutBytes: [4096, 1048576], maxStderrBytes: [0, 16384],
  };
  const result = { ...defaults };
  for (const key of keys) {
    const [minimum, maximum] = ranges[key];
    if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum)
      fail("resolver_request_invalid", `resolver limits.${key} is outside its hard ceiling`);
    result[key] = value[key];
  }
  return result;
}

function createResolverClient(options = {}) {
  // The production command and module root are deliberately not deployment
  // configuration: the accepted resolver implementation ships with Ask.
  // spawnImpl exists solely as a controlled-test seam.
  const spawnImpl = options.spawnImpl || spawn;
  const childEnvironment = () => {
    const environment = { ...process.env };
    // -E is the interpreter-level defense; removing the variables also keeps
    // the owned child's environment honest for subprocesses and diagnostics.
    for (const key of Object.keys(environment))
      if (key.startsWith("PYTHON")) delete environment[key];
    return environment;
  };
  const run = (input, limits) => new Promise((resolve, reject) => {
    let child;
    let timer = null;
    try {
      child = spawnImpl(BUNDLED_RESOLVER_ARGV[0], BUNDLED_RESOLVER_ARGV.slice(1), {
        cwd: BUNDLED_MODULE_ROOT,
        env: childEnvironment(),
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ResolverClientError("resolver_dependency_missing",
        "Ask's internal Python resolver could not be started", { cause: error }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const killOwnedGroup = () => {
      const pid = Number(child?.pid || 0);
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        try { process.kill(-pid, "SIGKILL"); return; } catch {}
      }
      try { child.kill("SIGKILL"); } catch {}
    };
    const terminate = (code, message, details = {}) => {
      killOwnedGroup();
      finish(new ResolverClientError(code, message, details));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.stdout) return terminate("resolver_output_limit", "agent-window-resolver stdout exceeded its bound");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > limits.stderr) return terminate("resolver_output_limit", "agent-window-resolver stderr exceeded its bound");
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(new ResolverClientError(
      error?.code === "ENOENT" ? "resolver_dependency_missing" : "resolver_dependency_unavailable",
      "Ask's internal Python resolver could not be started", { cause: error })));
    child.once("close", (code, signal) => {
      // A compliant resolver has already reaped its collectors. Ensure an
      // abnormal implementation cannot leave an adapter-owned descendant.
      killOwnedGroup();
      finish(null, {
        code, signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    timer = setTimeout(() => terminate("resolver_deadline_exceeded", "agent-window-resolver exceeded its adapter deadline"), limits.timeout);
    child.stdin.once("error", (error) => {
      if (error?.code !== "EPIPE")
        terminate("resolver_io_error", "could not write resolver request", { cause: error });
    });
    child.stdin.end(input);
  });

  const request = async (value) => {
    if (!value || value.schema !== REQUEST_SCHEMA || typeof value.requestId !== "string")
      fail("resolver_request_invalid", "resolver request is not protocol v1");
    if (value.operation === "match") validateMatchRequest(value);
    const limits = effectiveLimits(value.limits);
    const encoded = `${JSON.stringify(value)}\n`;
    const requestBytes = Buffer.byteLength(encoded, "utf8");
    if (requestBytes > limits.maxRequestBytes)
      fail("resolver_request_too_large", "resolver request exceeds its configured byte limit");
    const result = await run(encoded, {
      stdout: limits.maxStdoutBytes,
      stderr: limits.maxStderrBytes,
      timeout: Math.min(22000, limits.deadlineMs + 1500),
    });
    let response;
    try {
      if (!result.stdout.endsWith("\n") || result.stdout.slice(0, -1).includes("\n")) throw new Error("framing");
      response = JSON.parse(result.stdout);
    } catch {
      if (result.code !== 0 && !result.stdout) {
        const missing = result.code === 127 || /no module named\s+agent_window_resolver/i.test(result.stderr);
        fail(missing ? "resolver_dependency_missing" : "resolver_dependency_unavailable",
          missing ? "Ask's internal Python resolver is unavailable"
            : "Ask's internal Python resolver failed without a protocol response");
      }
      fail("resolver_response_incompatible", "Ask's internal resolver did not emit one JSON response");
    }
    validateResolverResponse(response, value);
    if (result.signal || result.code !== expectedExitCode(response))
      fail("resolver_response_incompatible", "agent-window-resolver exit code contradicts its response");
    const dependency = response.reasons.find((reason) => reason.code === "dependency_missing" || reason.code === "dependency_incompatible");
    if (dependency)
      fail(dependency.code === "dependency_missing" ? "resolver_dependency_missing" : "resolver_dependency_incompatible", dependency.message);
    return response;
  };
  return { request };
}

export {
  BUNDLED_MODULE_ROOT,
  BUNDLED_RESOLVER_ARGV,
  REQUEST_SCHEMA,
  RESPONSE_SCHEMA,
  ResolverClientError,
  canonicalTicks,
  createResolverClient,
  validateResolverResponse,
};
