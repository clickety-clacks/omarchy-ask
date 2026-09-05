import { readFileSync, accessSync, statSync, constants } from "node:fs";
import { join } from "node:path";

export function resolveHarness(env = process.env) {
  let agent = String(env.ASK_AGENT || "").trim();
  if (!agent) {
    try { agent = readFileSync(join(env.HOME, ".config/omarchy/defaults/agent"), "utf8").trim(); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error("Ask could not read Omarchy’s default agent. Check its file permissions.");
    }
  }
  if (!agent) throw new Error("No default agent is configured. Choose one in Omarchy’s Default Agent settings, or select a harness in Ask (Super+,).");
  if (!["codex", "claude"].includes(agent))
    throw new Error(`Omarchy’s selected agent (${agent}) is not supported by Ask yet. Choose Codex or Claude in Ask (Super+,).`);
  return agent;
}

export function resolveExecutable(agent, env = process.env) {
  const override = env[agent === "codex" ? "CODEX_PATH" : "CLAUDE_CODE_EXECUTABLE"];
  const executable = override || agent;
  const candidates = executable.includes("/") ? [executable]
    : (env.PATH || "").split(":").filter(Boolean).map(directory => join(directory, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`${agent === "codex" ? "Codex" : "Claude Code"} could not be launched: ${override ? "the configured executable is missing or not executable" : "it is not on the system PATH"}. Repair the system installation or choose another harness in Ask (Super+,).`);
}
