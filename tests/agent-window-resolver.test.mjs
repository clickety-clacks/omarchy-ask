import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUNDLED_MODULE_ROOT, BUNDLED_RESOLVER_ARGV, createResolverClient, canonicalTicks,
  validateResolverResponse,
} from "../bridge/agent-window-resolver.js";

const request = () => ({
  schema: "agent-window-resolver.request.v1", requestId: "ask-test-1",
  operation: "resolve", requestedRelation: "visible_exact",
  target: { identity: { machine: "remote.example", instanceId: "roster-1", pid: 200, startTimeTicks: "42" } },
  local: { machine: "local.example" },
  windows: [{ stableId: "abc", address: "0xabc", pid: 100, startTimeTicks: "20" }],
});
const unresolved = (r) => ({
  schema: "agent-window-resolver.response.v1", requestId: r.requestId,
  operation: r.operation, requestedRelation: r.requestedRelation,
  status: "unresolved", candidates: [], evidence: [],
  reasons: [{ code: "candidate_count", source: "proc", message: "No match", retryable: false }],
});
const matched = (r) => ({
  ...unresolved(r), status: "matched", reasons: [], candidates: [{
    window: { ...r.windows[0] }, target: { identity: { ...r.target.identity }, location: { kind: "local" } },
    proof: { state: "complete", relation: "visible_exact", evidence: [{ code: "target_process_live", source: "proc", result: "supports" }] },
  }],
});
const matchRequest = () => ({
  schema: "agent-window-resolver.request.v1", requestId: "ask-match-1",
  operation: "match",
  target: {
    identity: { machine: "remote.example", instanceId: "roster-1", pid: 200, startTimeTicks: "42" },
    name: "Build agent",
  },
  local: { machine: "local.example" },
  windows: [
    { stableId: "abc", address: "0xabc", pid: 100, startTimeTicks: "20",
      class: "com.mitchellh.ghostty", title: "Build agent — tmux" },
    { stableId: "def", address: "0xdef", pid: 101, startTimeTicks: "21",
      class: "com.mitchellh.ghostty", title: "remote shell" },
  ],
});
const matchCandidate = (r, index = 0) => ({
  window: { ...r.windows[index] },
  // Descriptive name/title are matching inputs, not process identity. The
  // normalized target may omit name and a live title may have changed.
  target: { identity: { ...r.target.identity }, location: { kind: "local" } },
  match: {
    confidence: index ? "medium" : "high", score: index ? 70 : 95,
    evidence: [{ code: "title_name_match", source: "caller", result: "supports" }],
    uncertainty: index
      ? [{ code: "generic_title", source: "caller", message: "Title is not unique", retryable: false }]
      : [],
  },
});
const matchResponse = (r) => ({
  schema: "agent-window-resolver.response.v1", requestId: r.requestId,
  operation: "match", status: "matched",
  candidates: [matchCandidate(r, 0), matchCandidate(r, 1)],
  evidence: [], reasons: [],
});

function fakeClient(body, inspect = () => {}) {
  // A controlled subprocess, not the shared Linux collector. The child waits
  // for EOF, so successful requests also test the one-request framing.
  const program = `
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', part => text += part);
    process.stdin.on('end', () => {
      const request = JSON.parse(text);
      const response = (${unresolved.toString()})(request);
      ${body}
    });
  `;
  return createResolverClient({ spawnImpl(command, args, options) {
    inspect(command, args, options);
    return spawn(process.execPath, ["-e", program.replace(/\n/g, " "), "--"], options);
  } });
}

test("ticks retain uint64 precision and reject unsafe numeric input", () => {
  assert.equal(canonicalTicks("18446744073709551615"), "18446744073709551615");
  assert.equal(canonicalTicks(42), "42");
  assert.equal(canonicalTicks(0), "0");
  for (const value of [9007199254740992, "18446744073709551616", "01", "-1", "1e3", null, true])
    assert.throws(() => canonicalTicks(value));
});

test("bundled resolver files retain the accepted canonical hashes", () => {
  const expected = {
    "__init__.py": "eb4317c4f98a441006f7dd11e458596c8df32a5487b1ccccba5743ad69ea285b",
    "__main__.py": "6d8b7d7846a845059d7a3107143f11131f63c5511d669b44085b15ec5e3d2279",
    "cli.py": "8456de39f7234d2d21d1b8fb1b322de59aa97348498bf5c90dbc2fbf0c45474a",
    "collector.py": "06f510e61e598b4378effeb7198b22d5d310e428dbf42396849e5b0c0cb860cc",
    "linux.py": "f2911ba1d4cca826542ed8c1a8be571a6688ac7f37443b7cd996775d7663af45",
    "model.py": "c917960688c83989998beb77b8a070ff250df061683a6dd47610d2063b6e172d",
    "resolver.py": "0be324ff3bf9052182c7114b5976a0e6e3ab4696942b6f123da934b1268b65bb",
  };
  const packagePath = join(BUNDLED_MODULE_ROOT, "agent_window_resolver");
  assert.deepEqual(readdirSync(packagePath).filter((name) => name.endsWith(".py")).sort(),
    Object.keys(expected).sort());
  for (const [name, hash] of Object.entries(expected))
    assert.equal(createHash("sha256").update(readFileSync(join(packagePath, name))).digest("hex"), hash);
});

test("client uses the fixed bundled Python module and one EOF-framed request", async () => {
  let invocations = 0;
  const client = fakeClient("process.stdout.write(JSON.stringify(response) + '\\n');",
    (command, args, options) => {
      invocations++;
      assert.equal(command, "python3");
      assert.deepEqual(args, ["-B", "-S", "-E", "-m", "agent_window_resolver"]);
      assert.equal(options.cwd, BUNDLED_MODULE_ROOT);
      assert.equal(options.shell, false);
      assert.equal(Object.keys(options.env).some((key) => key.startsWith("PYTHON")), false);
    });
  const result = await client.request(request());
  assert.equal(result.status, "unresolved");
  assert.equal(result.requestId, "ask-test-1");
  assert.equal(invocations, 1, "a version handshake must not create another child");
});

test("client rejects wrong response schema, request identity and extra frames", async () => {
  for (const body of [
    "response.schema = 'wrong'; console.log(JSON.stringify(response));",
    "response.requestId = 'other'; console.log(JSON.stringify(response));",
    "console.log(JSON.stringify(response)); console.log(JSON.stringify(response));",
    "console.log('not JSON');",
  ]) await assert.rejects(fakeClient(body).request(request()));
});

test("missing internal Python runtime is an explicit dependency error", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const client = createResolverClient({ spawnImpl() { throw missing; } });
  await assert.rejects(client.request(request()), { code: "resolver_dependency_missing" });
});

test("client rejects exit status contradicting a valid response", async () => {
  await assert.rejects(fakeClient("console.log(JSON.stringify(response)); process.exitCode = 4;").request(request()));
});

test("client enforces bounded subprocess output", async () => {
  await assert.rejects(fakeClient("process.stdout.write('x'.repeat(1048577));").request(request()));
  await assert.rejects(fakeClient("process.stderr.write('x'.repeat(16385)); console.log(JSON.stringify(response));").request(request()));
});

test("caller limits cannot be widened or silently treated as defaults", async () => {
  for (const limits of [null, { deadlineMs: 0 }, { deadlineMs: 20001 }, { maxStdoutBytes: 1048577 }, { maxStderrBytes: -1 }]) {
    const r = request(); r.limits = limits;
    await assert.rejects(fakeClient("console.log(JSON.stringify(response));").request(r));
  }
});

test("client respects a caller's lower output ceiling", async () => {
  const r = request(); r.limits = { maxStdoutBytes: 4096 };
  await assert.rejects(fakeClient("response.evidence = Array.from({length:80},()=>({code:'sample',source:'proc',result:'informational'})); console.log(JSON.stringify(response));").request(r));
});

test("bundled module launch ignores external resolver and Python configuration", async () => {
  const before = process.env.PYTHONPATH;
  const priorArgv = process.env.ASK_AGENT_WINDOW_RESOLVER_ARGV;
  const priorHome = process.env.PYTHONHOME;
  try {
    process.env.ASK_AGENT_WINDOW_RESOLVER_ARGV = '["/should/not/be/used"]';
    process.env.PYTHONHOME = "/hostile/python/home";
    const client = fakeClient("if(Object.keys(process.env).some(key => key.startsWith('PYTHON'))) process.exit(9); console.log(JSON.stringify(response));");
    await client.request(request());
    assert.equal(process.env.PYTHONPATH, before);
  } finally {
    if (priorArgv === undefined) delete process.env.ASK_AGENT_WINDOW_RESOLVER_ARGV;
    else process.env.ASK_AGENT_WINDOW_RESOLVER_ARGV = priorArgv;
    if (priorHome === undefined) delete process.env.PYTHONHOME;
    else process.env.PYTHONHOME = priorHome;
  }
});

test("trusted cwd defeats package shadowing and fixed Python launch writes no bytecode", () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-resolver-shadow-"));
  const fakePackage = join(directory, "agent_window_resolver");
  mkdirSync(fakePackage);
  writeFileSync(join(fakePackage, "__main__.py"), "raise SystemExit('SHADOW PACKAGE EXECUTED')\n");
  const priorCwd = process.cwd();
  const environment = {
    ...process.env,
    PYTHONHOME: join(directory, "hostile-home"),
    PYTHONPATH: directory,
    PYTHONSTARTUP: join(directory, "startup.py"),
    PYTHONUSERBASE: directory,
  };
  try {
    process.chdir(directory);
    const result = spawnSync(BUNDLED_RESOLVER_ARGV[0],
      BUNDLED_RESOLVER_ARGV.slice(1).concat("--version"), {
        cwd: BUNDLED_MODULE_ROOT, env: environment, encoding: "utf8", timeout: 3000,
      });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "agent-window-resolver 0.1.0\n");
    assert.doesNotMatch(result.stderr, /SHADOW PACKAGE EXECUTED/);
    const residue = readdirSync(BUNDLED_MODULE_ROOT, { recursive: true })
      .filter((name) => String(name).includes("__pycache__") || String(name).endsWith(".pyc"));
    assert.deepEqual(residue, []);
  } finally {
    process.chdir(priorCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("response validation rejects unproven or substituted focus targets", () => {
  const r = request();
  assert.doesNotThrow(() => validateResolverResponse(matched(r), r));
  for (const mutate of [
    v => { v.operation = "verify-target"; },
    v => { v.candidates[0].proof.state = "partial"; },
    v => { v.candidates[0].proof.relation = "linked_client"; },
    v => { v.candidates[0].target.identity.startTimeTicks = "43"; },
    v => { v.candidates[0].target.identity.instanceId = "new-roster"; },
    v => { v.candidates[0].window.pid = 101; },
    v => { v.candidates.push(structuredClone(v.candidates[0])); },
  ]) {
    const value = matched(r); mutate(value);
    assert.throws(() => validateResolverResponse(value, r));
  }
});

test("revalidation cannot substitute a different supplied window", () => {
  const r = request();
  r.operation = "revalidate";
  r.prior = matched(r).candidates[0];
  r.windows.push({ stableId: "def", address: "0xdef", pid: 101, startTimeTicks: "21" });
  const response = matched(r);
  response.candidates[0].window = r.windows[1];
  assert.throws(() => validateResolverResponse(response, r));
});

test("wire responses require string ticks even when numeric values are safe", () => {
  const r = request();
  for (const mutate of [
    value => { value.candidates[0].target.identity.startTimeTicks = 42; },
    value => { value.candidates[0].window.startTimeTicks = 20; },
  ]) {
    const response = matched(r); mutate(response);
    assert.throws(() => validateResolverResponse(response, r));
  }
});

test("verified attachment target must preserve requested identity and pane", () => {
  const r = request();
  r.operation = "verify-target";
  delete r.requestedRelation;
  r.windows = [];
  r.target.tmux = { session: "agents", windowIndex: "0", paneId: "%7" };
  const response = {
    schema: "agent-window-resolver.response.v1", requestId: r.requestId,
    operation: "verify-target", status: "verified", candidates: [], evidence: [], reasons: [],
    verifiedTarget: { identity: r.target.identity,
      location: { kind: "tmux", tmux: { ...r.target.tmux, socket: { kind: "path", value: "/test/tmux.sock" } } },
      evidence: [{ code: "target_process_live", source: "proc", result: "supports" }] },
  };
  assert.doesNotThrow(() => validateResolverResponse(response, r));
  response.verifiedTarget.location.tmux.paneId = "%8";
  assert.throws(() => validateResolverResponse(response, r));
});

test("match accepts ranked metadata candidates without manufacturing proof", () => {
  const r = matchRequest();
  const response = matchResponse(r);
  response.candidates[0].window.title = "title changed after collection";
  assert.doesNotThrow(() => validateResolverResponse(response, r));
  assert.equal(response.candidates.length, 2);
  assert.equal(Object.hasOwn(response.candidates[0], "proof"), false);
});

test("client exchanges an additive match request with no relation or prior", async () => {
  const body = `
    response.status = "matched";
    response.reasons = [];
    response.candidates = [{
      window: request.windows[0],
      target: { identity: request.target.identity, location: { kind: "local" } },
      match: { confidence: "high", score: 91,
        evidence: [{ code: "title_name_match", source: "caller", result: "supports" }],
        uncertainty: [] }
    }];
    console.log(JSON.stringify(response));
  `;
  const response = await fakeClient(body).request(matchRequest());
  assert.equal(response.operation, "match");
  assert.equal(response.candidates[0].match.score, 91);
});

test("match request rejects legacy fields, duplicate identities and unbounded metadata", async () => {
  const cases = [];
  const relation = matchRequest(); relation.requestedRelation = "visible_exact"; cases.push(relation);
  const prior = matchRequest(); prior.prior = matchCandidate(prior); cases.push(prior);
  const duplicate = matchRequest(); duplicate.windows.push({ ...duplicate.windows[0] }); cases.push(duplicate);
  const title = matchRequest(); title.windows[0].title = "x".repeat(513); cases.push(title);
  const name = matchRequest(); name.target.name = "x\u0000y"; cases.push(name);
  for (const value of cases)
    await assert.rejects(fakeClient("console.log(JSON.stringify(response));").request(value));
});

test("match response enforces cardinality, rank shape and full identities", () => {
  const r = matchRequest();
  const mutations = [
    value => { value.candidates = []; },
    value => { value.candidates[0].proof = { state: "complete" }; },
    value => { delete value.candidates[0].match; },
    value => { value.candidates[0].match.confidence = "certain"; },
    value => { value.candidates[0].match.score = 101; },
    value => { value.candidates[0].match.score = 4.5; },
    value => { value.candidates[0].match.evidence = []; },
    value => { value.candidates[0].match.evidence = [{}]; },
    value => { value.candidates[0].match.uncertainty = [{}]; },
    value => { value.candidates[0].target.name = "not part of targetResult"; },
    value => { value.candidates[0].window.pid = 999; },
    value => { value.candidates[0].target.identity.instanceId = "other"; },
    value => { value.candidates.push(structuredClone(value.candidates[0])); },
    value => { value.status = "ambiguous"; },
    value => { value.requestedRelation = "visible_exact"; },
  ];
  for (const mutate of mutations) {
    const response = matchResponse(r); mutate(response);
    assert.throws(() => validateResolverResponse(response, r));
  }
  const unresolvedMatch = matchResponse(r);
  unresolvedMatch.status = "unresolved";
  unresolvedMatch.candidates = [];
  unresolvedMatch.reasons = [{
    code: "candidate_count", source: "caller", message: "No metadata match", retryable: false,
  }];
  assert.doesNotThrow(() => validateResolverResponse(unresolvedMatch, r));
});

test("match preserves an omitted default tmux socket without inventing proof", () => {
  const r = matchRequest();
  r.target.tmux = { session: "agents", windowIndex: "0", paneId: "%7" };
  const response = matchResponse(r);
  for (const candidate of response.candidates)
    candidate.target.location = { kind: "tmux", tmux: { ...r.target.tmux } };
  assert.doesNotThrow(() => validateResolverResponse(response, r));
  response.candidates[0].target.location.tmux.socket = {
    kind: "path", value: "/run/user/1000/tmux/default",
  };
  assert.throws(() => validateResolverResponse(response, r),
    "best-effort match must not invent a proved default socket path");
});

test("additive title remains valid on legacy candidate windows", () => {
  const r = request();
  r.windows[0].title = "current compositor title";
  const response = matched(r);
  response.candidates[0].window.title = r.windows[0].title;
  assert.doesNotThrow(() => validateResolverResponse(response, r));
});

test("match response bounds candidate and nested diagnostic collections", () => {
  const r = matchRequest();
  const tooManyCandidates = matchResponse(r);
  tooManyCandidates.candidates = Array.from({ length: 4097 }, () => structuredClone(tooManyCandidates.candidates[0]));
  assert.throws(() => validateResolverResponse(tooManyCandidates, r));
  for (const field of ["evidence", "uncertainty"]) {
    const response = matchResponse(r);
    response.candidates[0].match[field] = Array.from({ length: 129 }, () =>
      field === "evidence"
        ? { code: "sample", source: "caller", result: "informational" }
        : { code: "sample", source: "caller", message: "uncertain", retryable: false });
    assert.throws(() => validateResolverResponse(response, r));
  }
});
