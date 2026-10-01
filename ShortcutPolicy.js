.pragma library

// Hyprland modifier bits; these are application shortcuts, NOT system bindings.
// Keep context-sensitive claims tied to the handlers enabled in Conversation.
function conversation(state) {
  var keys = ["0:Up", "0:Down", "0:Page_Up", "0:Page_Down",
    "4:j", "4:k", "4:u", "4:d", "4:equal", "4:plus",
    "4:minus", "4:0", "4:p", "4:comma", "64:comma"]
  // Pinned windows deliberately have no Escape-to-close shortcut. The
  // composer's selection dismissal is the only exception in that window.
  if (state.overlay || (state.composer && state.menuSelected)) keys.push("0:Escape")
  if (!state.files) keys.push("0:Left", "0:Right", "4:h", "4:l", "5:plus", "5:underscore")
  if (state.menu || state.files) {
    for (var n = 1; n <= 9; ++n) keys.push("4:" + n)
    keys.push("0:Tab", "1:ISO_Left_Tab", "1:Tab")
  }
  if (state.composer) {
    keys.push("4:w", "4:e")
    if (state.searchMode && state.emptyPrompt) keys.push("0:BackSpace")
  }
  if (state.composer || state.files) {
    keys.push("0:Return", "0:KP_Enter", "4:Return", "4:KP_Enter", "8:Return", "8:KP_Enter")
    if (state.files || state.searchMode) keys.push("1:Return", "1:KP_Enter")
  }
  if (state.permission) keys.push("0:y", "0:n")
  return keys.join(" ")
}

function harness() { return "0:Escape 64:comma 0:Return" }
function motion() { return "0:Escape 4:comma" }
