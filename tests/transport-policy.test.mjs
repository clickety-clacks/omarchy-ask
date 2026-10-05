// Ask's transport choice against the vectors shared with Yoohoo.
// tests/fixtures/transport-policy-v1.json is agent-window-resolver's
// fixtures/transport-policy-v1.json, copied by scripts/sync-resolver.py and
// pinned by bridge/agent_window_resolver/VENDORED.json.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CAPABILITY_MAX_AGE_MS, UNKNOWN_CAPABILITY_MAX_AGE_MS, TRANSPORT_PREFERENCES, capabilityDirectory, capabilityPath,
  chooseTransport, readCapabilities, recordCapabilities, transportLaunchArgv, transportPreference,
} from "../bridge/transport-policy.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/transport-policy-v1.json", import.meta.url)));

test("choice matches every shared vector", () => {
  assert.equal(vectors.schema, "transport-policy.v1");
  assert.deepEqual([...TRANSPORT_PREFERENCES], vectors.preferences);
  for (const c of vectors.policy)
    assert.deepEqual(chooseTransport(c.preference, c.targetIsLocal, c.clients, c.capabilities), c.expect, c.name);
});

test("launch matches every shared vector", () => {
  for (const c of vectors.launch)
    assert.deepEqual(transportLaunchArgv(c.transport, c.fallback, c.host, c.remote, c.etPort, c.staleFile), c.expect, c.name);
});

test("unknown preferences mean auto", () => {
  assert.equal(transportPreference("et"), "et");
  for (const value of [undefined, "", "telnet", 3]) assert.equal(transportPreference(value), "auto");
});

const observation = (state = "complete") => ({ resolverVersion: "0.2.0", transports: {
  state,
  ssh: { state: "available", code: "ssh_probe_succeeded" },
  et: { state: "available", code: "et_reachable", port: 4022 },
  mosh: { state: "unavailable", code: "mosh_udp_blocked" },
} });

test("capability records live apart from settings and never take an unreachable result", () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-capability-"));
  try {
    assert.equal(readCapabilities(directory, "atlas"), null);
    assert.equal(recordCapabilities(directory, "Atlas.", observation(), 1000), true);
    assert.ok(existsSync(join(directory, "atlas.json")));
    assert.deepEqual(readCapabilities(directory, "atlas", 2000),
      { ssh: "available", et: "available", mosh: "unavailable", etPort: 4022 });
    assert.equal(recordCapabilities(directory, "atlas", observation("unreachable"), 1500), false);
    assert.equal(readCapabilities(directory, "atlas", 2000).et, "available");
    assert.equal(readCapabilities(directory, "atlas", CAPABILITY_MAX_AGE_MS + 1001), null);
    for (const host of ["../x", "a/b", "-x", ""]) assert.equal(capabilityPath(directory, host), null);
    const unknown = { transports: { state: "partial", ...Object.fromEntries(["ssh", "et", "mosh"]
      .map(name => [name, { state: "unknown", code: "probe_failed" }])) } };
    recordCapabilities(directory, "blank", unknown, 0);
    assert.ok(readCapabilities(directory, "blank", 3600 * 1000), "all-unknown record holds for a day");
    assert.equal(readCapabilities(directory, "blank", UNKNOWN_CAPABILITY_MAX_AGE_MS + 1), null);
    assert.match(capabilityDirectory({ XDG_STATE_HOME: "/s" }), /^\/s\/omarchy-ask\/transport-capabilities$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
