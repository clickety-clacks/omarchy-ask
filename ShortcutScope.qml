import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "ShortcutPlatform.js" as ShortcutPlatform

// Advertise ONLY this surface's own shortcuts. The compositor routes all other
// keys through its original live keybindings; no keymap snapshot is involved.
Item {
  id: root
  required property var targetWindow
  required property string surfaceName
  required property string chords
  readonly property string instance: ShortcutPlatform.instance(Hyprland.requestSocketPath,
    Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE"))
  readonly property var nativeWindow: targetWindow ? targetWindow.contentItem.Window.window : null
  readonly property bool focused: !!nativeWindow && nativeWindow.active && targetWindow.visible
  property bool ready: false
  // Initial admission is latched until hide. Context updates and reloads must
  // not hide an existing window or pull focus back from another application.
  property bool admitted: false
  property bool focusEstablished: false
  property bool dirty: false
  property int attempts: 0

  function registered(exitCode) {
    if (!registerScope.awaitingReply) return
    registerScope.awaitingReply = false
    ready = exitCode === 0 && String(registerScope.stdout.text).trim() === "ok" && !dirty
    if (!targetWindow.visible) return
    if (ready || (!dirty && attempts >= 5)) admitted = true
    if (dirty || (!ready && attempts < 5)) retry.restart()
  }

  function schedule() {
    ready = false
    dirty = true
    attempts = 0
    if (targetWindow && targetWindow.visible) retry.restart()
  }
  onFocusedChanged: {
    if (focused && !ready) schedule()
    if (focused) Qt.callLater(function() {
      if (root.focused) root.focusEstablished = true
    })
  }
  onChordsChanged: schedule()
  Component.onCompleted: schedule()

  Connections {
    target: root.targetWindow
    function onVisibleChanged() {
      if (!root.targetWindow.visible) {
        root.admitted = false
        root.focusEstablished = false
      }
      root.schedule()
    }
    function onBackingWindowVisibleChanged() { root.schedule() }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event.name === "configreloaded" || event.name === "askshortcuts") root.schedule()
    }
  }
  Timer {
    id: retry
    interval: root.attempts === 0 ? 0 : 20
    onTriggered: {
      if (!root.targetWindow.visible || registerScope.running) return
      // Visibility changes before the layer-shell surface has necessarily
      // mapped. Keep probing briefly: without this retry the first zero-delay
      // attempt returns here and the surface never registers its scope.
      if (!root.targetWindow.backingWindowVisible) {
        root.attempts++
        if (root.attempts < 5) retry.restart()
        else root.admitted = true
        return
      }
      if (root.instance === "") { root.admitted = true; return }
      root.dirty = false
      root.attempts++
      registerScope.command = ["hyprctl", "-i", root.instance, "askshortcuts", "set",
        String(Quickshell.processId), JSON.stringify(root.surfaceName)].concat(root.chords.split(" ").filter(s => s !== ""))
      registerScope.awaitingReply = true
      registerScope.running = true
    }
  }
  Process {
    id: registerScope
    property bool awaitingReply: false
    stdout: StdioCollector {}
    onExited: function(exitCode) { root.registered(exitCode) }
    onRunningChanged: {
      if (!running && awaitingReply) Qt.callLater(function() {
        if (!registerScope.running && registerScope.awaitingReply) root.registered(-1)
      })
    }
  }
}
