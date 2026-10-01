.pragma library

// Prefer the compositor connection Quickshell is actually using. Never choose
// the first running compositor when a session has no usable identity.
function instance(socketPath, environment) {
  var match = String(socketPath || "").match(/\/hypr\/([^/]+)\/\.socket\.sock$/)
  var candidate = match ? match[1] : String(environment || "")
  return /^[A-Za-z0-9_.-]+$/.test(candidate) && !/^\d+$/.test(candidate) ? candidate : ""
}
