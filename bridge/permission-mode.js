// Ask's permission mode must reach the agent, not only Ask's own permission
// prompts. Adapters start in their own default mode (codex-acp starts in
// "Approve for me", an automatic reviewer that rejects tools Ask never sees),
// so the bridge sets the session mode to match. Modes are chosen by the
// adapter's advertised kind rather than by id, so adapter renames still work.
export function agentModeFor(permissionMode, sessionModes) {
  const available = sessionModes?.availableModes || [];
  const kindOf = (mode) => mode?._meta?.kind;
  if (permissionMode === "yolo")
    return available.find((mode) => kindOf(mode) === "full_access")?.id || null;
  const current = available.find((mode) => mode.id === sessionModes?.currentModeId);
  if (kindOf(current) === "standard") return current.id;
  return available.find((mode) => kindOf(mode) === "standard")?.id || null;
}
