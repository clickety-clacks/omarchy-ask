import QtQuick
import Quickshell.Wayland

// Match Omarchy's KeyboardPanel focus lifecycle: acquire focus when summoned,
// then release the compositor-wide exclusive grab. Keeping it exclusive would
// prevent native window-focus shortcuts from doing their normal work.
Item {
  id: root
  required property var targetWindow
  property bool wanted: true
  property bool allowed: true
  property bool primed: false
  readonly property int mode: !targetWindow.visible || !allowed || !wanted ? WlrKeyboardFocus.None
    : (primed ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.Exclusive)

  function prime() {
    primed = false
    settle.stop()
    if (allowed && wanted && targetWindow.visible && targetWindow.backingWindowVisible) settle.restart()
  }
  onWantedChanged: prime()
  onAllowedChanged: prime()
  Component.onCompleted: prime()
  Connections {
    target: root.targetWindow
    function onVisibleChanged() { root.prime() }
    function onBackingWindowVisibleChanged() { root.prime() }
  }
  Timer {
    id: settle
    // Same interval as Omarchy's KeyboardPanel: allow Wayland commit cycles.
    interval: 75
    onTriggered: if (root.wanted && root.targetWindow.visible) root.primed = true
  }
}
