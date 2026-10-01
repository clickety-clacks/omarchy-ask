import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "../" as Ask

PanelWindow {
  id: root
  property int ownedPresses: 0
  property int otherPresses: 0
  property int unregisteredFocus: 0
  property int lastKey: 0
  property int lastModifiers: 0
  implicitWidth: 600
  implicitHeight: 240
  visible: true
  WlrLayershell.namespace: "omarchy-ask"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: focusLifecycle.mode
  Ask.ShortcutFocus { id: focusLifecycle; targetWindow: root; allowed: scope.admitted }
  color: "#283333"
  exclusionMode: ExclusionMode.Ignore

  Ask.ShortcutScope {
    id: scope
    targetWindow: root
    surfaceName: "omarchy-ask"
    chords: "64:comma 4:Return"
    onReadyChanged: console.log("SCOPE_READY " + ready)
    onFocusedChanged: if (focused && !ready) root.unregisteredFocus++
  }
  IpcHandler {
    target: "shortcutTest"
    function closeSurface(): void { root.visible = false }
    function openSurface(): void { root.visible = true }
    function claim(chords: string): void { scope.chords = chords }
    function focusOther(): void { other.visible = true }
    function focusAsk(): void { other.visible = false; focusLifecycle.prime() }
    function state(): string {
      return JSON.stringify({ ready: scope.ready, focused: scope.focused, attempts: scope.attempts,
        owned: root.ownedPresses, other: root.otherPresses, visible: root.visible,
        focusPrimed: focusLifecycle.primed, pid: Quickshell.processId,
        admitted: scope.admitted, unregisteredFocus: root.unregisteredFocus,
        lastKey: root.lastKey, lastModifiers: root.lastModifiers })
    }
  }
  FloatingWindow {
    id: other
    visible: false
    title: "Ask Shortcut Test Other"
    implicitWidth: 200
    implicitHeight: 200
    TextInput { anchors.fill: parent; focus: true; text: "Other window" }
  }
  TextInput {
    anchors.fill: parent
    anchors.margins: 20
    color: "white"
    focus: true
    text: "Shortcut routing test (no agent)"
    Keys.onPressed: event => {
      if ([Qt.Key_Control, Qt.Key_Shift, Qt.Key_Alt, Qt.Key_Meta,
           Qt.Key_CapsLock, Qt.Key_NumLock].indexOf(event.key) >= 0) {
        event.accepted = true
        return
      }
      root.lastKey = event.key
      root.lastModifiers = event.modifiers
      if ((event.key === Qt.Key_Comma && event.modifiers === Qt.MetaModifier)
          || (event.key === Qt.Key_Return && event.modifiers === Qt.ControlModifier)) root.ownedPresses++
      else root.otherPresses++
      event.accepted = true
    }
  }
}
