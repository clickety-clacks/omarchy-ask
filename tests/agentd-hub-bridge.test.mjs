import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../bridge/agentd-hub.js", import.meta.url));

function api(expression) {
  const script = `
    import { hostname } from "node:os";
    import { readFile } from "node:fs/promises";
    import { agentIdentity, transportLaunchScript, tmuxAttachCommand,
      resolveFocusAddress, sameAgentTarget, activate, chooseExistingCandidate } from ${JSON.stringify(bridge)};
    import { ResolverClientError } from ${JSON.stringify(fileURLToPath(new URL("../bridge/agent-window-resolver.js", import.meta.url)))};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Shared process/transport matching regressions live in agent-window-resolver.
// This file tests Ask-owned identity, attachment and compositor policy only.
test("same-target candidates prefer score then active then MRU", () => {
  const result = api(`(() => {
    const candidates=['aa','bb'].map((id,i)=>({window:{stableId:id,address:'0x'+id,pid:100+i},match:{score:70}}));
    const clients=candidates.map((c,i)=>({...c.window,mapped:true,focusHistoryID:i}));
    const active=chooseExistingCandidate(candidates,clients,'0xbb').window.stableId;
    const mru=chooseExistingCandidate(candidates,clients,'').window.stableId;
    candidates[0].match.score=90;
    const score=chooseExistingCandidate(candidates,clients,'0xbb').window.stableId;
    return {active,mru,score};
  })()`);
  assert.deepEqual(result,{active:'bb',mru:'aa',score:'aa'});
});

test("attach command targets exact window and pane in one operation", () => {
  const agent = { tmux: { session: "ask", windowIndex: 0, paneId: "%1", socket: { kind: "name", value: "ask-sock" } } };
  const command = api(`tmuxAttachCommand(${JSON.stringify(agent)})`);
  assert.match(command, /attach-session/);
  assert.doesNotMatch(command, /select-window|select-pane/);
  assert.match(command, /'-L' 'ask-sock'/);
  assert.match(command, /'=ask:0\.%1'/);
  assert.doesNotMatch(command, /^exec\s/);
});

test("agent identity is structured and cannot collide through separators", () => {
  const first = { machine: "a|b", instanceId: "c", id: { pid: 4, startTimeTicks: 5 } };
  const second = { machine: "a", instanceId: "b|c", id: { pid: 4, startTimeTicks: 5 } };
  const result = api(`[
    agentIdentity(${JSON.stringify(first)}),
    agentIdentity(${JSON.stringify(second)})
  ]`);
  assert.notEqual(result[0], result[1]);
  assert.deepEqual(JSON.parse(result[0]), ["a|b", "c", 4, "5"]);
});

test("mosh launcher falls back only on nonzero startup and not normal exit", () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-agent-transport-"));
  const log = join(directory, "transport.log");
  const writeFake = (name) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' ${name} >> "$ASK_TRANSPORT_LOG"\nif [ "${name}" = "mosh" ]; then exit "${"$ASK_MOSH_EXIT"}"; fi\nexit 0\n`);
    chmodSync(path, 0o755);
  };
  writeFake("mosh");
  writeFake("ssh");
  const script = api(`transportLaunchScript("gibson", { session: "ask", windowIndex: 0, paneId: "%1" })`);
  assert.match(script, /'ssh' '-tt'/);
  const environment = {
    ...process.env, PATH: `${directory}:${process.env.PATH || ""}`, ASK_TRANSPORT_LOG: log,
  };
  const normal = spawnSync("sh", ["-c", script], {
    encoding: "utf8", env: { ...environment, ASK_MOSH_EXIT: "0" }, timeout: 3000,
  });
  assert.equal(normal.status, 0, normal.error?.message || normal.stderr || "normal launcher failed");
  assert.equal(readFileSync(log, "utf8"), "mosh\n");
  writeFileSync(log, "");
  const failed = spawnSync("sh", ["-c", script], {
    encoding: "utf8", env: { ...environment, ASK_MOSH_EXIT: "7" }, timeout: 3000,
  });
  assert.equal(failed.status, 0, failed.error?.message || failed.stderr || "fallback launcher failed");
  assert.equal(readFileSync(log, "utf8"), "mosh\nssh\n");
  rmSync(directory, { recursive: true, force: true });
});

test("final focus resolution rejects a closed or reused Hypr window", () => {
  const match = { address: "0xabc", stableId: "deadbeef", pid: 42 };
  const current = [{ address: "0xabc", stableId: "deadbeef", pid: 42, mapped: true }];
  const moved = [{ address: "0xdef", stableId: "deadbeef", pid: 42, mapped: true }];
  const reused = [{ address: "0xabc", stableId: "other", pid: 99, mapped: true }];
  assert.equal(api(`resolveFocusAddress(${JSON.stringify(match)}, ${JSON.stringify(current)})`), "0xabc");
  assert.equal(api(`resolveFocusAddress(${JSON.stringify(match)}, ${JSON.stringify(moved)})`), "");
  assert.equal(api(`resolveFocusAddress(${JSON.stringify(match)}, ${JSON.stringify(reused)})`), "");
  assert.equal(api(`resolveFocusAddress(${JSON.stringify(match)}, [])`), "");
});

test("final focus resolution rejects a roster removal or moved tmux target", () => {
  const base = {
    machine: "gibson", instanceId: "i", id: { pid: 42, startTimeTicks: 9 },
    tmux: { session: "ask", windowIndex: 0, paneId: "%1" },
  };
  const moved = { ...base, tmux: { session: "ask", windowIndex: 1, paneId: "%2" } };
  assert.equal(api(`sameAgentTarget(${JSON.stringify(base)}, ${JSON.stringify(base)})`), true);
  assert.equal(api(`sameAgentTarget(${JSON.stringify(base)}, ${JSON.stringify(moved)})`), false);
  assert.equal(api(`sameAgentTarget(${JSON.stringify(base)}, null)`), false);
});

function activationScenario(mode) {
  return api(`(async () => {
    const mode = ${JSON.stringify(mode)};
    let agent = { machine: 'remote.example', instanceId: 'i', id: {pid:200,startTimeTicks:'42'},
      tmux:{session:'agents',windowIndex:'0',paneId:'%7'}, hubSourceState:'reporting',presence:{state:'present'} };
    if(mode==='stale-existing') { agent.hubSourceState='unreachable'; agent.presence.state='unknown'; }
    const window = {stableId:'abc',address:'0xabc',pid:100,startTimeTicks:'20'};
    const calls = [], events = [], notices = [], launches = [], focused = [];
    const deps = {
      lookupAgent:()=>agent, isHubConnected:()=>mode!=='stale-existing',
      activeWindowAddress:async()=>'',
      compositorWindows:async()=>{if(mode==='snapshot-failure')throw new Error('unavailable');return [window]},
      hyprClientsSnapshot:async()=>[{...window,mapped:true,address:mode==='changed-address'?'0xdef':'0xabc'}],
      readStartTicks:async()=>mode==='reused-pid'?'21':'20',
      focus:async address=>{focused.push(address);return true},
      showNotice:async(a,r)=>notices.push(r), emit:e=>events.push(e),
      which:async name=>{if(name==='mosh' && mode==='moved-during-discovery')agent={...agent,tmux:{...agent.tmux,paneId:'%8'}};return '/fake/'+name},
      spawnDetached:async(...args)=>{launches.push(args);return true},
      resolver:{request:async r=>{
        calls.push(r.operation);
        if(mode==='dependency-failure')throw new Error('missing dependency');
        if(mode==='revalidate-dependency-failure' && calls.length===2)throw new ResolverClientError('resolver_dependency_missing','missing shared resolver');
        if(r.operation==='verify-target')return {status:'verified',verifiedTarget:{identity:r.target.identity,location:{kind:'tmux',tmux:{...r.target.tmux,socket:{kind:'path',value:'/test/proved.sock'}}}}};
        if(['attach','moved-during-discovery'].includes(mode))return {status:'unresolved',candidates:[],reasons:[{code:'candidate_count'}]};
        if(mode==='incomplete-scan')return {status:'unresolved',candidates:[],reasons:[{code:'local_collection_incomplete'}]};
        if(mode==='ambiguous')return {status:'ambiguous',candidates:[]};
        if(mode==='removed-during-revalidation' && calls.length===2)agent=null;
        if(mode==='lost-during-rematch' && calls.length===2)return {status:'unresolved',candidates:[]};
        if(mode==='substituted-during-rematch' && calls.length===2)return {status:'matched',candidates:[{window:{...window,stableId:'other',address:'0xdef'},match:{score:70,confidence:'medium',evidence:[],uncertainty:[]}}]};
        return {status:'matched',candidates:[{window,target:{identity:r.target.identity,location:{kind:'tmux',tmux:r.target.tmux}},match:{confidence:'medium',score:70,evidence:[],uncertainty:[]}}]};
      }},
    };
    const id=agentIdentity(agent); await activate(id,deps);
    return {calls,events,notices,launches,focused};
  })()`);
}

test("existing activation revalidates then focuses without touching connection", () => {
  for(const mode of ['existing','stale-existing']) {
    const result=activationScenario(mode);
    assert.deepEqual(result.calls,['match','match']);
    assert.deepEqual(result.focused,['0xabc']);
    assert.equal(result.launches.length,0);
    assert.equal(result.events[0].existing,true);
  }
});

test("changed window, PID, or roster cancels focus without new attachment", () => {
  for(const mode of ['changed-address','reused-pid','removed-during-revalidation','lost-during-rematch','substituted-during-rematch','incomplete-scan','ambiguous','dependency-failure','snapshot-failure']) {
    const result=activationScenario(mode);
    assert.equal(result.focused.length,0,mode);
    assert.equal(result.launches.length,0,mode);
    assert.equal(result.events[0].ok,false,mode);
  }
});

test("new attachment verifies target and uses proven socket with mosh preference", () => {
  const result=activationScenario('attach');
  assert.deepEqual(result.calls,['match','verify-target']);
  assert.equal(result.launches.length,1);
  assert.match(JSON.stringify(result.launches[0]),/proved.sock/);
  assert.equal(result.events[0].transport,'mosh');
  assert.equal(result.focused.length,0);
});

test("roster movement during executable discovery cancels attachment", () => {
  const result=activationScenario('moved-during-discovery');
  assert.equal(result.launches.length,0);
  assert.equal(result.events[0].ok,false);
});

test("dependency failure during revalidation retains its truthful notice", () => {
  const result=activationScenario('revalidate-dependency-failure');
  assert.deepEqual(result.notices,['resolver_dependency_missing']);
  assert.equal(result.events[0].reason,'resolver_dependency_missing');
  assert.equal(result.focused.length,0);
  assert.equal(result.launches.length,0);
});
