import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
  id: root
  signal closed()
  property bool opened: false
  property bool layoutReady: false
  property bool waiting: false
  property bool bridgeReady: false
  property bool sessionLost: false
  property bool pinned: false
  property string statusText: ""
  property int activeReply: -1
  property string activeReplyMessageId: ""
  property string queuedPrompt: ""
  property string pendingPermissionId: ""
  property string pendingPermissionTitle: ""
  property var permissionQueue: []
  property string permissionMode: "permission"

  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color border: Color.menu.border
  readonly property color accent: Color.accent
  readonly property color scrim: Color.menu.scrim
  readonly property string conversationFont: "Noto Serif"
  readonly property int agentSize: Math.round(Style.font.body * 1.34)
  readonly property int humanSize: Math.round(Style.font.body * 2.36)

  function humanSizeFor(text) {
    // Keep short prompts display-sized, but react quickly once they begin to
    // wrap. Newlines count extra because they consume vertical space even
    // when the raw character count is low. Assistant size is the hard floor.
    var value = String(text || "")
    var newlines = (value.match(/\n/g) || []).length
    var visualLength = value.length + newlines * 32
    var progress = Math.max(0, Math.min(1, (visualLength - 24) / 216))
    return Math.round(humanSize - (humanSize - agentSize) * progress)
  }

  function open(payloadJson) {
    layoutReady = false
    card.opacity = 0
    veil.opacity = 0
    opened = true
    entranceTimer.restart()
    agent.running = true
  }

  function close() {
    agent.running = false
    entranceTimer.stop()
    cardFade.stop()
    veilFade.stop()
    card.opacity = 0
    veil.opacity = 0
    layoutReady = false
    opened = false
    pinned = false
    waiting = false
    bridgeReady = false
    sessionLost = false
    queuedPrompt = ""
    clearPermissions()
    statusText = ""
    activeReply = -1
    activeReplyMessageId = ""
    prompt.text = ""
    messages.clear()
    closed()
  }

  function toggle() { opened ? close() : open("{}") }

  function pinConversation() {
    if (!opened || pinned) return
    pinned = true
    Qt.callLater(function() { prompt.forceActiveFocus() })
  }

  function scrollToEnd() {
    horizontalScroll.stop()
    verticalScroll.stop()
    // Let the border absorb ordinary growth. Only scroll once the surface has
    // reached its height cap; scrolling during the growth animation makes the
    // entire conversation appear to jump or redraw.
    if (card.height < card.maxHeight - 1) {
      surface.contentY = 0
      return
    }
    var overflow = surface.contentHeight - surface.height
    surface.contentY = overflow > 0 ? overflow : 0
  }

  function isAtEnd() {
    var maxY = Math.max(0, surface.contentHeight - surface.height)
    return maxY <= 0 || surface.contentY >= maxY - Style.space(18)
  }

  function scrollBy(dx, dy) {
    var maxX = Math.max(0, surface.contentWidth - surface.width)
    var maxY = Math.max(0, surface.contentHeight - surface.height)
    var nextX = Math.max(0, Math.min(maxX, surface.contentX + dx))
    var nextY = Math.max(0, Math.min(maxY, surface.contentY + dy))
    if (nextX !== surface.contentX) {
      horizontalScroll.stop()
      horizontalScroll.from = surface.contentX
      horizontalScroll.to = nextX
      horizontalScroll.start()
    }
    if (nextY !== surface.contentY) {
      verticalScroll.stop()
      verticalScroll.from = surface.contentY
      verticalScroll.to = nextY
      verticalScroll.start()
    }
  }

  function scrollLine(dx, dy) {
    scrollBy(dx * Style.space(44), dy * Style.space(44))
  }

  function scrollPage(direction) {
    scrollBy(0, direction * Math.max(Style.space(44), surface.height * 0.85))
  }

  function handlePinKey(event) {
    if ((event.modifiers & Qt.ControlModifier) === 0) return false
    if (event.key !== Qt.Key_P) return false
    pinConversation()
    return true
  }

  function submit() {
    var text = prompt.text.trim()
    if (text === "" || waiting || sessionLost) return
    waiting = true
    statusText = "Thinking…"
    queuedPrompt = text
    prompt.text = ""
    messages.append({ role: "You", body: text })
    activeReply = messages.count
    activeReplyMessageId = ""
    messages.append({ role: "Claude", body: "" })
    if (bridgeReady) sendQueuedPrompt()
    else statusText = "Starting agent…"
  }

  function sendQueuedPrompt() {
    if (queuedPrompt === "" || !agent.running || !bridgeReady) return
    agent.write(JSON.stringify({
      type: "prompt",
      text: queuedPrompt
    }) + "\n")
    queuedPrompt = ""
  }

  function setPermissionMode(mode) {
    var next = mode === "yolo" ? "yolo" : "permission"
    permissionMode = next
    if (next === "yolo") clearPermissions()
    if (agent.running && bridgeReady) {
      agent.write(JSON.stringify({ type: "permission_mode", mode: next }) + "\n")
    }
  }

  function appendReply(text, messageId) {
    if (activeReply < 0 || activeReply >= messages.count || text === "") return
    var followTail = isAtEnd()
    var nextMessageId = String(messageId || "")
    if (nextMessageId !== "" && activeReplyMessageId !== "" && nextMessageId !== activeReplyMessageId) {
      activeReply = messages.count
      messages.append({ role: "Claude", body: "" })
    }
    if (nextMessageId !== "") activeReplyMessageId = nextMessageId
    messages.setProperty(activeReply, "body", (messages.get(activeReply).body || "") + text)
    if (followTail) Qt.callLater(root.scrollToEnd)
  }

  function clearPermissions() {
    pendingPermissionId = ""
    pendingPermissionTitle = ""
    permissionQueue = []
  }

  function enqueuePermission(id, title) {
    var request = { id: String(id || ""), title: String(title || "Allow tool?") }
    if (pendingPermissionId === "") {
      pendingPermissionId = request.id
      pendingPermissionTitle = request.title
    } else {
      permissionQueue = permissionQueue.concat([request])
    }
  }

  function showNextPermission() {
    if (permissionQueue.length === 0) {
      pendingPermissionId = ""
      pendingPermissionTitle = ""
      return
    }
    var request = permissionQueue[0]
    permissionQueue = permissionQueue.slice(1)
    pendingPermissionId = request.id
    pendingPermissionTitle = request.title
  }

  function handleAgentLine(rawLine) {
    var line = String(rawLine || "").trim()
    if (line === "") return
    try {
      var event = JSON.parse(line)
      if (event.type === "ready") {
        bridgeReady = true
        permissionMode = event.permissionMode === "yolo" ? "yolo" : "permission"
        statusText = queuedPrompt === "" ? "" : "Thinking…"
        sendQueuedPrompt()
      } else if (event.type === "text") {
        appendReply(String(event.text || ""), String(event.messageId || ""))
        statusText = "Replying…"
      } else if (event.type === "done") {
        waiting = false
        statusText = ""
        activeReply = -1
        activeReplyMessageId = ""
        clearPermissions()
        Qt.callLater(function() { prompt.forceActiveFocus() })
      } else if (event.type === "status") {
        statusText = String(event.text || "Working…")
      } else if (event.type === "tool") {
        var toolTitle = String(event.title || "Using a tool")
        var toolStatus = String(event.status || "in_progress")
        statusText = toolStatus === "completed" ? "Thinking…" : toolTitle
      } else if (event.type === "permission") {
        enqueuePermission(event.id, event.title)
      } else if (event.type === "permission_mode") {
        permissionMode = event.mode === "yolo" ? "yolo" : "permission"
      } else if (event.type === "error") {
        clearPermissions()
        waiting = false
        activeReply = -1
        activeReplyMessageId = ""
        statusText = String(event.message || "Agent error")
        Qt.callLater(function() { prompt.forceActiveFocus() })
      } else if (event.type === "fatal") {
        clearPermissions()
        bridgeReady = false
        sessionLost = true
        waiting = false
        activeReply = -1
        activeReplyMessageId = ""
        statusText = String(event.message || "Session lost") + " · close to restart"
      }
    } catch (error) {}
  }

  function answerPermission(allow) {
    if (pendingPermissionId === "" || !agent.running) return
    var answeredId = pendingPermissionId
    agent.write(JSON.stringify({
      type: "permission",
      id: answeredId,
      allow: allow
    }) + "\n")
    showNextPermission()
    statusText = allow ? "Working…" : "Tool denied"
  }

  ListModel { id: messages }

  // Layer-shell geometry arrives asynchronously from the compositor. Keep the
  // overlay fully transparent until that handshake has settled, then reveal
  // the already measured, centered card with opacity alone.
  Timer {
    id: entranceTimer
    interval: 400
    repeat: false
    onTriggered: {
      root.layoutReady = true
      prompt.forceActiveFocus()
      cardFade.restart()
      veilFade.restart()
    }
  }

  Process {
    id: agent
    command: [
      "env", "HUGINN_INTERNAL=1",
      "node", Quickshell.env("HOME") + "/.config/omarchy/plugins/clickety-clacks.ask/bridge/bridge.js"
    ]
    stdinEnabled: true
    onExited: function(code) {
      root.clearPermissions()
      root.bridgeReady = false
      if (!root.opened) return
      root.waiting = false
      root.activeReply = -1
      root.sessionLost = true
      root.statusText = "ACP session ended · close to restart"
    }
    stdout: SplitParser { onRead: function(line) { root.handleAgentLine(line) } }
    stderr: SplitParser {
      onRead: function(line) {
        // The bridge keeps its machine-readable UI stream on stdout. stderr
        // is reserved for bridge-level diagnostics and is intentionally quiet.
      }
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened && !root.pinned
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-ask"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Shortcut { sequence: "Escape"; onActivated: root.close() }
    Shortcut { sequence: "Up"; onActivated: root.scrollLine(0, -1) }
    Shortcut { sequence: "Down"; onActivated: root.scrollLine(0, 1) }
    Shortcut { sequence: "Left"; onActivated: root.scrollLine(-1, 0) }
    Shortcut { sequence: "Right"; onActivated: root.scrollLine(1, 0) }
    Shortcut { sequence: "Ctrl+H"; onActivated: root.scrollLine(-1, 0) }
    Shortcut { sequence: "Ctrl+J"; onActivated: root.scrollLine(0, 1) }
    Shortcut { sequence: "Ctrl+K"; onActivated: root.scrollLine(0, -1) }
    Shortcut { sequence: "Ctrl+L"; onActivated: root.scrollLine(1, 0) }
    Shortcut { sequence: "Ctrl+U"; onActivated: root.scrollPage(-1) }
    Shortcut { sequence: "Ctrl+D"; onActivated: root.scrollPage(1) }
    Shortcut { sequence: "PageUp"; onActivated: root.scrollPage(-1) }
    Shortcut { sequence: "PageDown"; onActivated: root.scrollPage(1) }
    Shortcut { sequence: "Ctrl+P"; onActivated: root.pinConversation() }
    Shortcut {
      sequence: "Y"
      enabled: root.pendingPermissionId !== ""
      onActivated: root.answerPermission(true)
    }
    Shortcut {
      sequence: "N"
      enabled: root.pendingPermissionId !== ""
      onActivated: root.answerPermission(false)
    }
    Rectangle {
      id: veil
      anchors.fill: parent
      color: root.scrim
      visible: root.layoutReady
      opacity: 0
    }
    NumberAnimation { id: veilFade; target: veil; property: "opacity"; from: 0; to: 1; duration: 150; easing.type: Easing.OutQuad }
    MouseArea { anchors.fill: parent; onClicked: root.close() }

    BorderSurface {
      id: card
      parent: root.pinned ? pinnedWindow.contentItem : panel.contentItem
      readonly property int maxHeight: Math.min(Style.space(560), parent.height - Style.gapsOut * 2)
      readonly property int frameInset: Style.spacing.panelPadding * 2
      width: root.pinned ? parent.width : Math.min(Style.space(540), parent.width - Style.gapsOut * 2)
      height: root.pinned ? parent.height : Math.min(maxHeight, stack.height + frameInset)
      anchors.horizontalCenter: parent.horizontalCenter
      y: root.pinned ? 0 : Math.max(Style.gapsOut, Math.round((parent.height - height) / 2))
      color: root.background
      visible: root.layoutReady
      radius: root.pinned ? 0 : Style.cornerRadius
      borderSpec: Border.surfaceSpec("menu", "border", root.border, Math.max(1, Style.space(2)))
      padding: Style.spacing.panelPadding
      opacity: 0
      Behavior on height {
        enabled: root.layoutReady
        NumberAnimation { duration: 280; easing.type: Easing.OutCubic }
      }
      MouseArea { anchors.fill: parent; onClicked: prompt.forceActiveFocus() }

      Flickable {
        id: surface
        anchors.fill: parent
        anchors.margins: Style.spacing.panelPadding
        clip: true
        contentWidth: width
        contentHeight: stack.height
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        NumberAnimation {
          id: horizontalScroll
          target: surface
          property: "contentX"
          duration: 170
          easing.type: Easing.OutCubic
        }
        NumberAnimation {
          id: verticalScroll
          target: surface
          property: "contentY"
          duration: 170
          easing.type: Easing.OutCubic
        }

        Column {
          id: stack
          width: surface.width
          spacing: Style.space(4)

          Repeater {
            model: messages
            Item {
              id: turn
              required property string role
              required property string body
              readonly property bool human: role === "You"
              width: stack.width
              height: human
                ? humanText.contentHeight
                : (body === "" ? 0 : agentText.contentHeight + Style.space(18))

              TextEdit {
                id: humanText
                visible: turn.human
                width: parent.width
                height: contentHeight
                text: turn.body
                color: root.accent
                font.family: root.conversationFont
                font.pixelSize: root.humanSizeFor(turn.body)
                font.italic: true
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                readOnly: true
                selectByMouse: true
                selectionColor: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.32)
                selectedTextColor: root.foreground
                Keys.onPressed: function(event) {
                  if (root.handlePinKey(event)) event.accepted = true
                }
              }
              TextEdit {
                id: agentText
                visible: !turn.human
                width: parent.width
                height: contentHeight
                text: turn.body
                color: root.foreground
                font.family: Style.font.family
                font.pixelSize: root.agentSize
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.MarkdownText
                readOnly: true
                selectByMouse: true
                selectionColor: Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.32)
                selectedTextColor: root.foreground
                onLinkActivated: function(link) { Qt.openUrlExternally(link) }
                Keys.onPressed: function(event) {
                  if (root.handlePinKey(event)) event.accepted = true
                }
              }
            }
          }

          Item {
            id: pulse
            width: stack.width
            visible: root.waiting || root.statusText !== ""
            height: visible ? Math.max(dot.height, statusLabel.implicitHeight) : 0
            Rectangle {
              id: dot
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(6)
              height: width
              radius: width / 2
              color: root.accent
              SequentialAnimation on opacity {
                running: pulse.visible
                loops: Animation.Infinite
                NumberAnimation { from: 0.22; to: 1; duration: 620 }
                NumberAnimation { from: 1; to: 0.22; duration: 620 }
              }
            }
            Text {
              id: statusLabel
              x: Style.space(12)
              width: parent.width - x
              anchors.verticalCenter: parent.verticalCenter
              text: root.statusText
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.42)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          Item {
            id: composer
            width: stack.width
            visible: !root.waiting
            height: visible ? Math.max(Style.space(54), prompt.contentHeight + Style.space(6)) : 0

            // Measure wrapping at the full display size. This gives the font
            // rule a stable visual-line count instead of making the resized
            // editor feed back into its own measurement.
            Text {
              id: promptMeasure
              visible: false
              width: prompt.width
              text: prompt.text
              font.family: root.conversationFont
              font.pixelSize: root.humanSize
              font.italic: true
              wrapMode: Text.Wrap
              textFormat: Text.PlainText
            }

            TextArea {
              id: prompt
              // Stay display-sized for one visual line, then reach assistant
              // size at seven lines. Explicit newlines and natural wraps count.
              readonly property real shrinkProgress: Math.max(0, Math.min(1, (promptMeasure.lineCount - 1) / 6))
              readonly property int responsiveFontSize: Math.round(root.humanSize - (root.humanSize - root.agentSize) * shrinkProgress)
              x: promptMarker.implicitWidth + Style.space(8)
              width: parent.width - x
              height: contentHeight
              anchors.verticalCenter: parent.verticalCenter
              padding: 0
              color: root.accent
              placeholderText: ""
              font.family: root.conversationFont
              font.pixelSize: responsiveFontSize
              font.italic: true
              wrapMode: TextEdit.Wrap
              enabled: !root.waiting
              background: null
              opacity: root.waiting ? 0.45 : 1
              onContentHeightChanged: if (activeFocus) Qt.callLater(root.scrollToEnd)
              Keys.onPressed: function(event) {
                if (root.handlePinKey(event)) {
                  event.accepted = true
                } else if (event.key === Qt.Key_Up) {
                  root.scrollLine(0, -1)
                  event.accepted = true
                } else if (event.key === Qt.Key_Down) {
                  root.scrollLine(0, 1)
                  event.accepted = true
                } else if (event.key === Qt.Key_Left) {
                  root.scrollLine(-1, 0)
                  event.accepted = true
                } else if (event.key === Qt.Key_Right) {
                  root.scrollLine(1, 0)
                  event.accepted = true
                } else if (event.key === Qt.Key_PageUp) {
                  root.scrollPage(-1)
                  event.accepted = true
                } else if (event.key === Qt.Key_PageDown) {
                  root.scrollPage(1)
                  event.accepted = true
                } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_K) {
                  root.scrollLine(0, -1)
                  event.accepted = true
                } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_J) {
                  root.scrollLine(0, 1)
                  event.accepted = true
                } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_H) {
                  root.scrollLine(-1, 0)
                  event.accepted = true
                } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_L) {
                  root.scrollLine(1, 0)
                  event.accepted = true
                } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_U) {
                  root.scrollPage(-1)
                  event.accepted = true
                } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_D) {
                  root.scrollPage(1)
                  event.accepted = true
                } else
                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                    && !(event.modifiers & Qt.ShiftModifier)) {
                  root.submit()
                  event.accepted = true
                }
              }
            }

            Text {
              id: promptMarker
              anchors.verticalCenter: prompt.verticalCenter
              text: ">"
              color: root.accent
              font.family: Style.font.family
              font.pixelSize: prompt.responsiveFontSize
            }
          }
        }
      }

      Text {
        id: modeToggle
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: Style.space(10)
        anchors.rightMargin: Style.space(10)
        z: 10
        text: root.permissionMode === "yolo" ? "YOLO" : "Ask"
        color: root.permissionMode === "yolo"
          ? root.accent
          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.42)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption

        MouseArea {
          anchors.fill: parent
          anchors.margins: -Style.space(6)
          cursorShape: Qt.PointingHandCursor
          onClicked: root.setPermissionMode(root.permissionMode === "yolo" ? "permission" : "yolo")
        }
      }

      Text {
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.rightMargin: Style.space(10)
        anchors.bottomMargin: Style.space(8)
        visible: !root.pinned
        text: "󰐃"
        color: pinMouse.containsMouse
          ? root.accent
          : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.36)
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: Style.font.body
        z: 10

        MouseArea {
          id: pinMouse
          anchors.fill: parent
          anchors.margins: -Style.space(7)
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.pinConversation()
        }
      }
    }

    Rectangle {
      id: permissionLayer
      parent: root.pinned ? pinnedWindow.contentItem : panel.contentItem
      anchors.fill: parent
      visible: root.pendingPermissionId !== ""
      color: Qt.rgba(root.scrim.r, root.scrim.g, root.scrim.b, 0.72)
      z: 20

      MouseArea { anchors.fill: parent }

      BorderSurface {
        id: permissionCard
        width: Math.min(Style.space(430), parent.width - Style.gapsOut * 2)
        height: permissionContent.implicitHeight + Style.spacing.panelPadding * 2
        anchors.centerIn: parent
        color: root.background
        radius: Style.cornerRadius
        borderSpec: Border.surfaceSpec("menu", "border", root.accent, Math.max(1, Style.space(2)))

        Column {
          id: permissionContent
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.margins: Style.spacing.panelPadding
          spacing: Style.space(14)

          Text {
            width: parent.width
            text: "Permission required"
            color: root.accent
            font.family: root.conversationFont
            font.pixelSize: root.agentSize
            font.italic: true
          }

          Text {
            width: parent.width
            text: root.pendingPermissionTitle
            color: root.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            maximumLineCount: 5
            elide: Text.ElideRight
          }

          Text {
            width: parent.width
            visible: root.permissionQueue.length > 0
            text: root.permissionQueue.length + " more permission request" + (root.permissionQueue.length === 1 ? "" : "s") + " queued"
            color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          Row {
            width: parent.width
            spacing: Style.space(12)

            Button {
              width: (parent.width - parent.spacing) / 2
              text: "N  Deny"
              bordered: true
              foreground: root.foreground
              fontFamily: Style.font.family
              fontSize: Style.font.body
              onClicked: root.answerPermission(false)
            }

            Button {
              width: (parent.width - parent.spacing) / 2
              text: "Y  Allow"
              bordered: true
              selected: true
              foreground: root.accent
              fontFamily: Style.font.family
              fontSize: Style.font.body
              onClicked: root.answerPermission(true)
            }
          }
        }
      }
    }

    NumberAnimation { id: cardFade; target: card; property: "opacity"; from: 0; to: 1; duration: 150; easing.type: Easing.OutQuad }
  }

  FloatingWindow {
    id: pinnedWindow
    visible: root.opened && root.pinned
    title: "Omarchy Ask"
    color: root.background
    implicitWidth: 760
    implicitHeight: 800
    minimumSize: Qt.size(480, 420)

    onVisibleChanged: {
      if (visible) {
        Qt.callLater(function() { prompt.forceActiveFocus() })
      } else if (root.opened && root.pinned) {
        root.close()
      }
    }

    Shortcut { sequence: "Escape"; onActivated: root.close() }
    Shortcut { sequence: "Ctrl+P"; onActivated: root.pinConversation() }
    Shortcut {
      sequence: "Y"
      enabled: root.pendingPermissionId !== ""
      onActivated: root.answerPermission(true)
    }
    Shortcut {
      sequence: "N"
      enabled: root.pendingPermissionId !== ""
      onActivated: root.answerPermission(false)
    }
  }
}
