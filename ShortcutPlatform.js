.pragma library

// Ask's shortcut precedence is a Hyprland compositor module. Other
// compositors (Scottland, through its Hyprland IPC shim) answer the same
// socket but cannot load it, so they get no instance and Ask goes straight to
// its documented fallback: native system shortcuts keep precedence.
function compositor(currentDesktop) {
  var desktops = String(currentDesktop || "").split(":").map(function(name) {
    return name.trim().toLowerCase()
  })
  return desktops.indexOf("scottland") >= 0 ? "scottland" : "hyprland"
}

// Prefer the compositor connection Quickshell is actually using. Never choose
// the first running compositor when a session has no usable identity.
function instance(socketPath, environment, currentDesktop) {
  if (compositor(currentDesktop) !== "hyprland") return ""
  var match = String(socketPath || "").match(/\/hypr\/([^/]+)\/\.socket\.sock$/)
  var candidate = match ? match[1] : String(environment || "")
  return /^[A-Za-z0-9_.-]+$/.test(candidate) && !/^\d+$/.test(candidate) ? candidate : ""
}
