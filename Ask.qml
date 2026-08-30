import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
  id: root

  // The shell assigns this if the property exists (shell.qml: `"shell" in item`).
  // It is the only route to the shared AppLibrary, which is what makes
  // applications searchable from the composer alongside menu rows.
  property var shell: null
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
  // How long typing has to pause before the menu search recomputes. Matching
  // is cheap; the resize it triggers is not, so this is really a tolerance
  // for how much the card is allowed to move while you type. Settable in
  // ask.json, which is watched, so an edit applies without a restart.
  readonly property int minSearchDebounceMs: 0
  readonly property int maxSearchDebounceMs: 2000
  property int searchDebounceMs: 270
  property real keyboardLineImpulse: 335
  property real keyboardDeceleration: 608
  property var fileOpenCommand: []
  property var fileEditCommand: []
  property bool useHyprlandShortcutSubmap: false
  property int repoSearchDepth: 6
  readonly property real keyboardPageImpulse: keyboardLineImpulse * (740 / 360)
  property bool settingsLoaded: false
  // Retained so writing the font scale cannot drop the mode the bridge owns.
  property string persistedPermissionMode: "permission"
  property bool copyToastVisible: false
  // One manager owns the compositor submap. Conversations only affect the
  // derived desired state; they never dispatch Hyprland commands themselves.
  readonly property bool shortcutSubmapDesired: useHyprlandShortcutSubmap
    && activeOverlay !== null && activeOverlay.opened && !activeOverlay.pinned
  property bool shortcutSubmapOwned: false
  property bool shortcutSubmapTarget: false
  property bool shortcutSubmapInitialized: false
  property int shortcutSubmapFailures: 0

  onShortcutSubmapDesiredChanged: {
    shortcutSubmapRetry.stop()
    shortcutSubmapFailures = 0
    reconcileShortcutSubmap()
  }

  function reconcileShortcutSubmap() {
    if (!shortcutSubmapInitialized || shortcutSubmapProc.running) return
    if (shortcutSubmapDesired === shortcutSubmapOwned) return
    shortcutSubmapTarget = shortcutSubmapDesired
    shortcutSubmapProc.command = [
      "hyprctl", "dispatch",
      "hl.dsp.submap(\"" + (shortcutSubmapTarget ? "omarchy-ask" : "reset") + "\")"
    ]
    shortcutSubmapProc.running = true
  }

  Process {
    id: shortcutSubmapProbe
    command: ["hyprctl", "submap"]
    stdout: StdioCollector {}
    Component.onCompleted: running = true
    onExited: function(exitCode) {
      var current = String(stdout.text || "").trim()
      root.shortcutSubmapOwned = current === "omarchy-ask"
      root.shortcutSubmapInitialized = true
      root.reconcileShortcutSubmap()
    }
  }

  Process {
    id: shortcutSubmapProc
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.shortcutSubmapOwned = root.shortcutSubmapTarget
        root.shortcutSubmapFailures = 0
        root.reconcileShortcutSubmap()
      } else {
        root.shortcutSubmapFailures++
        shortcutSubmapRetry.interval = Math.min(8000,
          250 * Math.pow(2, Math.min(5, root.shortcutSubmapFailures - 1)))
        shortcutSubmapRetry.restart()
      }
    }
  }

  Timer {
    id: shortcutSubmapRetry
    repeat: false
    onTriggered: root.reconcileShortcutSubmap()
  }

  Component.onDestruction: {
    // Best effort for graceful plugin unload. SUPER+ESCAPE remains the crash
    // recovery path because no in-process cleanup can run after SIGKILL.
    if (shortcutSubmapOwned || shortcutSubmapDesired)
      Quickshell.execDetached(["hyprctl", "dispatch", "hl.dsp.submap(\"reset\")"])
  }

  function showCopyToast() {
    copyToastFade.stop()
    copyToastCard.opacity = 1
    copyToastVisible = true
    copyToastHold.restart()
  }

  function setFontScale(value) {
    var next = Math.max(minFontScale, Math.min(maxFontScale, Math.round(value * 100) / 100))
    if (next === fontScale) return
    fontScale = next
    if (settingsLoaded) settingsSaveTimer.restart()
  }

  function adjustFontScale(step) { setFontScale(fontScale + step) }

  function setKeyboardMotion(impulse, deceleration) {
    var nextImpulse = Math.round(Math.max(80, Math.min(2000, impulse)))
    var nextDeceleration = Math.round(Math.max(100, Math.min(5000, deceleration)))
    if (nextImpulse === keyboardLineImpulse && nextDeceleration === keyboardDeceleration) return
    keyboardLineImpulse = nextImpulse
    keyboardDeceleration = nextDeceleration
    if (settingsLoaded) settingsSaveTimer.restart()
  }

  function loadSettings(raw) {
    var data = {}
    try { data = JSON.parse(raw || "{}") } catch (error) { data = {} }
    if (!data || typeof data !== "object") data = {}
    persistedPermissionMode = data.permissionMode === "yolo" ? "yolo" : "permission"
    var scale = Number(data.fontScale)
    fontScale = (isFinite(scale) && scale > 0)
      ? Math.max(minFontScale, Math.min(maxFontScale, scale))
      : 1
    var debounce = Number(data.searchDebounceMs)
    searchDebounceMs = isFinite(debounce)
      ? Math.round(Math.max(minSearchDebounceMs, Math.min(maxSearchDebounceMs, debounce)))
      : 270
    var impulse = Number(data.keyboardLineImpulse)
    keyboardLineImpulse = isFinite(impulse)
      ? Math.round(Math.max(80, Math.min(2000, impulse)))
      : 335
    var deceleration = Number(data.keyboardDeceleration)
    keyboardDeceleration = isFinite(deceleration)
      ? Math.round(Math.max(100, Math.min(5000, deceleration)))
      : 608
    fileOpenCommand = normalizeCommand(data.fileOpenCommand)
    fileEditCommand = normalizeCommand(data.fileEditCommand)
    useHyprlandShortcutSubmap = data.useHyprlandShortcutSubmap === true
    var repoDepth = Number(data.repoSearchDepth)
    repoSearchDepth = isFinite(repoDepth)
      ? (repoDepth <= 0 ? 0 : Math.max(1, Math.min(128, Math.round(repoDepth))))
      : 6
    settingsLoaded = true
  }

  function normalizeCommand(value) {
    if (typeof value === "string")
      return value.trim() === "" ? [] : [value.trim()]
    if (!Array.isArray(value)) return []
    var command = []
    for (var i = 0; i < value.length; i++) {
      var argument = String(value[i] || "")
      if (argument !== "") command.push(argument)
    }
    return command
  }

  function flushSettings() {
    if (!settingsLoaded) return
    settingsFile.setText(JSON.stringify({
      permissionMode: persistedPermissionMode,
      fontScale: fontScale,
      searchDebounceMs: searchDebounceMs,
      keyboardLineImpulse: keyboardLineImpulse,
      keyboardDeceleration: keyboardDeceleration,
      fileOpenCommand: fileOpenCommand,
      fileEditCommand: fileEditCommand,
      useHyprlandShortcutSubmap: useHyprlandShortcutSubmap,
      repoSearchDepth: repoSearchDepth
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

  MotionTuner {
    id: motionTuner
    impulse: root.keyboardLineImpulse
    deceleration: root.keyboardDeceleration
    onMotionChanged: function(nextImpulse, nextDeceleration) {
      root.setKeyboardMotion(nextImpulse, nextDeceleration)
    }
    onResetRequested: root.setKeyboardMotion(335, 608)
  }

  PanelWindow {
    id: copyToast
    visible: root.copyToastVisible
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-ask-copied"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore
    mask: Region { item: copyToastCard }

    BorderSurface {
      id: copyToastCard
      width: copyToastText.implicitWidth + Style.space(42)
      height: Style.space(58)
      anchors.horizontalCenter: parent.horizontalCenter
      y: Math.round(parent.height * 0.22)
      color: Color.menu.background
      radius: Style.cornerRadius
      borderSpec: Border.surfaceSpec("menu", "border", Color.accent,
        Math.max(1, Style.space(2)))

      Text {
        id: copyToastText
        anchors.centerIn: parent
        text: "✓  Copied!"
        color: Color.accent
        font.family: Style.font.family
        font.pixelSize: Math.round(Style.font.body * (4 / 3))
        font.bold: true
      }
    }

    Timer {
      id: copyToastHold
      interval: 1500
      onTriggered: copyToastFade.restart()
    }

    NumberAnimation {
      id: copyToastFade
      target: copyToastCard
      property: "opacity"
      from: 1
      to: 0
      duration: 500
      easing.type: Easing.OutQuad
      onFinished: root.copyToastVisible = false
    }
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
    if (remaining.length === 0) motionTuner.visible = false
    Qt.callLater(function() { conversation.destroy() })
  }

  function createConversation(payloadJson) {
    var conversation = conversationComponent.createObject(root)
    if (!conversation) return null
    conversations = conversations.concat([conversation])
    activeOverlay = conversation
    conversation.fontScale = Qt.binding(function() { return root.fontScale })
    conversation.shell = Qt.binding(function() { return root.shell })
    conversation.searchDebounceMs = Qt.binding(function() { return root.searchDebounceMs })
    conversation.keyboardLineImpulse = Qt.binding(function() { return root.keyboardLineImpulse })
    conversation.keyboardPageImpulse = Qt.binding(function() { return root.keyboardPageImpulse })
    conversation.keyboardDeceleration = Qt.binding(function() { return root.keyboardDeceleration })
    conversation.fileOpenCommand = Qt.binding(function() { return root.fileOpenCommand })
    conversation.fileEditCommand = Qt.binding(function() { return root.fileEditCommand })
    conversation.motionTunerOpen = Qt.binding(function() { return motionTuner.visible })
    conversation.fontScaleStepRequested.connect(function(step) { root.adjustFontScale(step) })
    conversation.fontScaleResetRequested.connect(function() { root.setFontScale(1) })
    conversation.motionTunerRequested.connect(function() { motionTuner.open() })
    conversation.copyConfirmed.connect(function() { root.showCopyToast() })
    conversation.permissionModeConfirmed.connect(function(mode) {
      root.persistedPermissionMode = mode === "yolo" ? "yolo" : "permission"
    })
    conversation.closed.connect(function() { root.removeConversation(conversation) })
    conversation.pinnedChanged.connect(function() {
      if (conversation.pinned && root.activeOverlay === conversation)
        root.activeOverlay = null
      root.reconcileShortcutSubmap()
    })
    conversation.open(payloadJson || "{}")
    reconcileShortcutSubmap()
    return conversation
  }

  function open(payloadJson) {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned) return
    createConversation(payloadJson)
  }

  function close() {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned)
      activeOverlay.close()
    reconcileShortcutSubmap()
  }

  function pinActive() {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned)
      activeOverlay.pinConversation()
  }

  function closeAll() {
    var snapshot = conversations.slice()
    for (var i = 0; i < snapshot.length; i++) snapshot[i].close()
    reconcileShortcutSubmap()
  }

  function toggle(payloadJson) {
    if (activeOverlay && activeOverlay.opened && !activeOverlay.pinned)
      activeOverlay.close()
    else
      createConversation(payloadJson)
  }
}
