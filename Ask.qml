import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var activeOverlay: null
  property var conversations: []
  readonly property bool opened: activeOverlay !== null
    && activeOverlay.opened
    && !activeOverlay.pinned

  // The manager owns the font scale so every conversation — overlay or pinned
  // window — reads one value and a single writer persists it.
  readonly property real minFontScale: 0.7
  readonly property real maxFontScale: 2
  readonly property string settingsPath: Quickshell.env("HOME") + "/.config/omarchy/ask.json"
  property real fontScale: 1
  property bool settingsLoaded: false
  // Retained so writing the font scale cannot drop the mode the bridge owns.
  property string persistedPermissionMode: "permission"

  function setFontScale(value) {
    var next = Math.max(minFontScale, Math.min(maxFontScale, Math.round(value * 100) / 100))
    if (next === fontScale) return
    fontScale = next
    if (settingsLoaded) settingsSaveTimer.restart()
  }

  function adjustFontScale(step) { setFontScale(fontScale + step) }

  function loadSettings(raw) {
    var data = {}
    try { data = JSON.parse(raw || "{}") } catch (error) { data = {} }
    if (!data || typeof data !== "object") data = {}
    persistedPermissionMode = data.permissionMode === "yolo" ? "yolo" : "permission"
    var scale = Number(data.fontScale)
    fontScale = (isFinite(scale) && scale > 0)
      ? Math.max(minFontScale, Math.min(maxFontScale, scale))
      : 1
    settingsLoaded = true
  }

  function flushSettings() {
    if (!settingsLoaded) return
    settingsFile.setText(JSON.stringify({
      permissionMode: persistedPermissionMode,
      fontScale: fontScale
    }, null, 2) + "\n")
  }

  FileView {
    id: settingsFile
    path: root.settingsPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadSettings(text())
    // First run: the file does not exist yet. Without this the scale would
    // never be marked loaded and would never be written.
    onLoadFailed: root.loadSettings("")
    onFileChanged: reload()
  }

  Timer {
    id: settingsSaveTimer
    interval: 200
    repeat: false
    onTriggered: root.flushSettings()
  }

  Component {
    id: conversationComponent
    Conversation {}
  }

  function removeConversation(conversation) {
    if (activeOverlay === conversation) activeOverlay = null
    var remaining = []
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i] !== conversation) remaining.push(conversations[i])
    }
    conversations = remaining
    Qt.callLater(function() { conversation.destroy() })
  }

  function createConversation(payloadJson) {
    var conversation = conversationComponent.createObject(root)
    if (!conversation) return null
    conversations = conversations.concat([conversation])
    activeOverlay = conversation
    conversation.fontScale = Qt.binding(function() { return root.fontScale })
    conversation.fontScaleStepRequested.connect(function(step) { root.adjustFontScale(step) })
    conversation.fontScaleResetRequested.connect(function() { root.setFontScale(1) })
    conversation.closed.connect(function() { root.removeConversation(conversation) })
    conversation.pinnedChanged.connect(function() {
      if (conversation.pinned && root.activeOverlay === conversation)
        root.activeOverlay = null
    })
    conversation.open(payloadJson || "{}")
    return conversation
  }

  function open(payloadJson) {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned) return
    createConversation(payloadJson)
  }

  function close() {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned)
      activeOverlay.close()
  }

  function pinActive() {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned)
      activeOverlay.pinConversation()
  }

  function closeAll() {
    var snapshot = conversations.slice()
    for (var i = 0; i < snapshot.length; i++) snapshot[i].close()
  }

  function toggle(payloadJson) {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned)
      activeOverlay.close()
    else
      createConversation(payloadJson)
  }
}
