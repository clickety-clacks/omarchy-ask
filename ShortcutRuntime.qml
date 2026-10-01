import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "ShortcutPlatform.js" as ShortcutPlatform

// One startup dependency check per Ask manager, not one compiler per window.
// No keybindings, user configuration, or ACP sessions are changed here.
Item {
  id: root
  property bool pending: true
  property bool available: false
  property string error: ""
  property string lastWarning: ""
  readonly property string instance: ShortcutPlatform.instance(Hyprland.requestSocketPath,
    Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE"))
  signal settled()

  function finish(success, message) {
    if (!pending) return
    available = success
    pending = false
    if (!available) {
      error = message || "Ask shortcut support could not start. Native system shortcuts remain active."
      if (error !== lastWarning) {
        console.warn(error)
        lastWarning = error
      }
    }
    settled()
  }

  function ensure() {
    if (available || loader.running) return
    pending = true
    error = ""
    var script = decodeURIComponent(String(Qt.resolvedUrl("hyprland/manage.mjs")).replace(/^file:\/\//, ""))
    var command = ["node", script, "load", "--instance", instance]
    var cache = String(Quickshell.env("ASK_SHORTCUT_CACHE_DIR") || "")
    if (cache !== "") command.push("--cache-dir", cache)
    loader.command = command
    loader.running = true
  }
  Component.onCompleted: ensure()
  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event.name === "askshortcuts" && event.data === "unavailable")
        root.available = false
    }
  }
  Process {
    id: loader
    stdout: StdioCollector {}
    stderr: StdioCollector {}
    onExited: function(exitCode) {
      var result = {}
      try { result = JSON.parse(String(stdout.text)) } catch (ignored) {}
      root.finish(exitCode === 0 && result.loaded === true, String(stderr.text).trim())
    }
    onRunningChanged: {
      if (!running && root.pending) Qt.callLater(function() {
        if (root.pending && !loader.running)
          root.finish(false, "Ask shortcut support could not start its Node process. Check that Node is available in the shell's PATH.")
      })
    }
  }
}
