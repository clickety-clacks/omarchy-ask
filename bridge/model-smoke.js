// Opt-in live integration test: uses the system harnesses and their existing
// credentials. Sends one small, tool-free prompt per model/effort combination.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const models = {
  codex: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"],
  claude: ["claude-opus-4-8", "claude-opus-5", "claude-fable-5", "claude-fable-5-1"],
};
const efforts = process.argv.includes("--full") ? ["low", "medium", "high", "xhigh", "max"] : ["low"];
const cases = [["", "", ""], ...Object.entries(models).flatMap(([agent, choices]) =>
  choices.flatMap(model => efforts.map(effort => [agent, model, effort])))];

async function check([agent, model, effort]) {
  const label = [agent || "Omarchy default", model, effort].filter(Boolean).join(" / ");
  const child = spawn(process.execPath, [new URL("bridge.js", import.meta.url).pathname], {
    env: { ...process.env, ASK_AGENT: agent, ASK_MODEL: model, ASK_REASONING_EFFORT: effort,
      ASK_INSPECT_CONFIG: "1", ASK_ACP_COMMAND: "", ASK_CODEX_ACP_COMMAND: "", ASK_CLAUDE_ACP_COMMAND: "" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let text = "", options = [], completed = false;
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90000);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line);
      if (event.type === "config_options") options = event.configOptions;
      if (event.type === "ready") {
        if (model) {
          const selected = options.find(option => option.category === "model" || option.id === "model");
          assert.ok(selected, "missing model metadata");
          assert.ok(selected.currentValue === model || (model === "claude-opus-5" && selected.currentValue === "opus[1m]"),
            `wrong model: ${selected.currentValue}`);
          const thought = options.find(option => option.category === "thought_level" || option.id === "reasoning_effort");
          assert.equal(thought?.currentValue, effort);
        }
        child.stdin.write(JSON.stringify({ type: "prompt", text: "Reply exactly ASK_SYSTEM_OK. Do not use tools." }) + "\n");
      }
      if (event.type === "text") text += event.text;
      if (event.type === "error" || event.type === "fatal") throw new Error(event.message);
      if (event.type === "permission") throw new Error("Unexpected tool request");
      if (event.type === "done") {
        assert.equal(text.trim(), "ASK_SYSTEM_OK");
        assert.equal(event.stopReason, "end_turn");
        completed = true;
        break;
      }
    }
    assert.ok(completed, "bridge ended or timed out before a verified answer");
    console.log(`PASS ${label}`);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
    child.kill("SIGTERM");
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  }
}

let failed = false;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cases.length) {
    try { await check(cases.shift()); }
    catch (error) { failed = true; console.error(`FAIL ${error.message}`); }
  }
}));
process.exitCode = failed ? 1 : 0;
