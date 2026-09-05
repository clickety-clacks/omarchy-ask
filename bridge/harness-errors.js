export function needsNewSession(error) {
  return /authentication required|not logged in|please log in|please login|^(?:ACP )?connection closed\.?$/i.test(String(error?.message || error || ""));
}

export function explainHarnessError(error, agent) {
  const message = String(error?.message || error || "Unknown agent error");
  const name = agent === "claude" ? "Claude Code" : "Codex";
  if (/authentication required|not logged in|please log in|please login/i.test(message))
    return `${name} needs a login. Open the system ${agent} harness and sign in, then start a new session in Ask.`;
  if (/requires? (?:a )?newer|upgrade.*(?:codex|claude)|(?:codex|claude).*outdated/i.test(message))
    return `${name} needs an update. Update the system harness, then start a new session in Ask. ${message}`;
  if (/^(?:ACP )?connection closed\.?$/i.test(message))
    return `${name} closed the connection. Start a new session; if it happens again, check that the system harness opens successfully outside Ask.`;
  return message;
}
