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

  // Font scale is owned by the manager so every conversation and both window
  // modes share one value, and so a single writer persists it.
  property real fontScale: 1
  signal fontScaleStepRequested(real step)
  signal fontScaleResetRequested()

  // Anchoring pins a freshly submitted prompt to the top of the viewport and
  // lets the reply fill the space beneath it. `tailSpace` is scratch room
  // appended past the transcript so the newest prompt can actually reach the
  // top; it shrinks as the reply grows, which holds the maximum scroll offset
  // at `anchorY` and keeps the prompt still. Once the reply outgrows the
  // viewport the room is gone and ordinary tail-following resumes.
  property bool anchorActive: false
  property real anchorY: 0
  readonly property real tailSpace: anchorActive
    ? Math.max(0, surface.height - Math.max(0, stack.height - anchorY))
    : 0

  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color border: Color.menu.border
  readonly property color accent: Color.accent
  readonly property color scrim: Color.menu.scrim
  readonly property string conversationFont: "Noto Serif"
  readonly property int agentSize: Math.round(Style.font.body * 1.15 * root.fontScale)
  readonly property int humanSize: Math.round(Style.font.body * 2.36 * root.fontScale)

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

  // Qt renders consecutive Markdown paragraphs with no vertical gap at all,
  // and folds a whitespace-only line away as blank. A paragraph holding one
  // non-breaking space survives and reads as a single blank line, so those are
  // inserted at paragraph breaks for display only; the stored message is not
  // touched. Fenced code is copied verbatim, where such a line would become
  // part of the code.
  function spacedMarkdown(text) {
    var value = String(text || "")
    if (value.indexOf("\n") < 0) return value
    var lines = value.split("\n")
    var out = []
    var fenced = false
    var pendingBreak = false
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var fence = /^\s{0,3}(```|~~~)/.test(line)
      if (fence) fenced = !fenced
      if (!fenced && !fence && line.trim() === "") {
        if (out.length > 0) pendingBreak = true
        continue
      }
      if (pendingBreak) {
        pendingBreak = false
        // A blank line before a list item marks a loose list. A paragraph
        // inserted there would split the list in two and restart ordered
        // numbering, so the original break is emitted unchanged instead.
        if (/^\s*([-*+]|\d+[.)])\s/.test(line)) out.push("")
        else out.push("", "\u00a0", "")
      }
      out.push(line)
    }
    return out.join("\n")
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
    anchorActive = false
    anchorY = 0
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
    // An anchor glide owns the viewport until it lands. Streaming chunks that
    // arrive mid-glide must not snap it to the end.
    if (anchorScroll.running) return
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
    // Steps accumulate onto a running animation's destination. Measuring from
    // the animated value instead would swallow most of a held key or a fast
    // wheel spin, because every event would restart from a half-finished move.
    var maxX = Math.max(0, surface.contentWidth - surface.width)
    var maxY = Math.max(0, surface.contentHeight - surface.height)
    var baseX = horizontalScroll.running ? horizontalScroll.to : surface.contentX
    var baseY = anchorScroll.running
      ? anchorScroll.to
      : (verticalScroll.running ? verticalScroll.to : surface.contentY)
    // Any deliberate scroll takes the viewport back from the glide.
    anchorScroll.stop()
    var nextX = Math.max(0, Math.min(maxX, baseX + dx))
    var nextY = Math.max(0, Math.min(maxY, baseY + dy))
    if (nextX !== baseX) {
      horizontalScroll.stop()
      horizontalScroll.from = surface.contentX
      horizontalScroll.to = nextX
      horizontalScroll.start()
    }
    if (nextY !== baseY) {
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

  function stepFontScale(step) { fontScaleStepRequested(step) }
  function resetFontScale() { fontScaleResetRequested() }

  // Anchor the newest prompt to the top of the viewport. Called after the
  // model append so the delegate exists and the column has placed it.
  function anchorPrompt(index) {
    // A transcript that still fits inside the card does not scroll at all, so
    // the prompt is already visible and anchoring would only add dead space.
    // Measure the laid-out column rather than `card.height`, which is still
    // animating towards its cap at this point.
    if (stack.height + card.frameInset < card.maxHeight - 1) return
    var item = messageRepeater.itemAt(index)
    if (!item) return
    anchorY = item.y
    anchorActive = true
    Qt.callLater(function() {
      horizontalScroll.stop()
      verticalScroll.stop()
      anchorScroll.stop()
      var maxY = Math.max(0, surface.contentHeight - surface.height)
      var target = Math.min(root.anchorY, maxY)
      if (Math.abs(target - surface.contentY) < 1) {
        surface.contentY = target
        return
      }
      anchorScroll.from = surface.contentY
      anchorScroll.to = target
      anchorScroll.start()
    })
  }

  // Ctrl +/-/0 resizes the conversation text. A focused TextEdit claims keys
  // before a window shortcut sees them, so this runs from the same key
  // handlers the scrolling set uses. Returns true when the key was consumed.
  // ------------------------------------------------- Omarchy menu in the box
  // The composer doubles as the menu's search field. Nothing is selected
  // until you arrow into the list, so Return in the composer always submits a
  // prompt and can never fire a menu action you did not aim at -- which
  // matters because those rows include package removal and power off.
  property int menuIndex: -1
  // The list opens under wherever the pointer happens to be resting, so a
  // bare `entered` would hand it the selection the instant it appears --
  // stealing it from the keyboard without anyone touching the mouse. Hover
  // only counts once the pointer has actually moved, and typing or arrowing
  // disarms it again.
  property bool menuMouseArmed: false
  readonly property bool menuOpen: menuSearch.hasResults && !root.waiting
  readonly property bool menuSelected: root.menuOpen && root.menuIndex >= 0

  function menuMove(delta) {
    if (!root.menuOpen) return false
    root.menuMouseArmed = false
    var next = root.menuIndex + delta
    if (next < -1) next = -1
    if (next >= menuSearch.rows.length) next = menuSearch.rows.length - 1
    root.menuIndex = next
    return true
  }

  function menuActivate() {
    if (!root.menuSelected) return false
    if (!menuSearch.run(root.menuIndex)) return false
    prompt.text = ""
    root.menuIndex = -1
    // Running a row is the whole errand: the overlay is ephemeral and has
    // nothing left to show, so it gets out of the way of whatever just
    // launched. A pinned conversation is a window someone kept on purpose,
    // so it stays and only clears the box.
    if (!root.pinned) root.close()
    return true
  }

  // Assigned by Ask.qml, which the shell assigns in turn.
  property var shell: null
  readonly property var appLibrary: root.shell ? root.shell.appLibrary : null

  // Result text tracks the same scale as the prompt, so Ctrl +/- moves the
  // whole box together rather than leaving the matches behind.
  readonly property int menuTitleSize: Math.round(Style.font.body * (4 / 3) * root.fontScale)
  readonly property int menuPathSize: Math.round(Style.font.caption * root.fontScale)

  MenuSearch {
    id: menuSearch
    query: root.waiting ? "" : prompt.text
    appLibrary: root.appLibrary
    onQueryChanged: { root.menuIndex = -1; root.menuMouseArmed = false }
  }

  function handleFontKey(event) {
    if ((event.modifiers & Qt.ControlModifier) === 0) return false
    if (event.key === Qt.Key_Plus || event.key === Qt.Key_Equal) { stepFontScale(0.1); return true }
    if (event.key === Qt.Key_Minus || event.key === Qt.Key_Underscore) { stepFontScale(-0.1); return true }
    if (event.key === Qt.Key_0) { resetFontScale(); return true }
    return false
  }

  // Ctrl+P pins the live conversation into a normal window. Like the font
  // keys, it runs from the shared key handlers because a focused TextEdit
  // claims the key before a window shortcut can see it.
  function handlePinKey(event) {
    if ((event.modifiers & Qt.ControlModifier) === 0) return false
    if (event.key !== Qt.Key_P) return false
    pinConversation()
    return true
  }

  // Every text item in the card takes focus when it is clicked, and a focused
  // TextEdit claims the navigation keys before a window shortcut can see them.
  // The composer and the transcript therefore route keys through here, so the
  // conversation scrolls wherever the caret happens to be. Returns true when
  // the key was consumed.
  function handleScrollKey(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    if (event.key === Qt.Key_Up || (ctrl && event.key === Qt.Key_K)) { scrollLine(0, -1); return true }
    if (event.key === Qt.Key_Down || (ctrl && event.key === Qt.Key_J)) { scrollLine(0, 1); return true }
    if (event.key === Qt.Key_Left || (ctrl && event.key === Qt.Key_H)) { scrollLine(-1, 0); return true }
    if (event.key === Qt.Key_Right || (ctrl && event.key === Qt.Key_L)) { scrollLine(1, 0); return true }
    if (event.key === Qt.Key_PageUp || (ctrl && event.key === Qt.Key_U)) { scrollPage(-1); return true }
    if (event.key === Qt.Key_PageDown || (ctrl && event.key === Qt.Key_D)) { scrollPage(1); return true }
    return false
  }

  // Shortcuts reach only the window that declares them, so the overlay panel
  // and the pinned window each need their own copy of the scrolling and font
  // set. These cover the case where nothing in the card holds focus at all.
  component WindowShortcuts: Item {
    // An inline component does not share the enclosing document's scope, so
    // the conversation is handed in rather than reached through its id.
    required property Item conversation
    Shortcut { sequence: "Up"; onActivated: conversation.scrollLine(0, -1) }
    Shortcut { sequence: "Down"; onActivated: conversation.scrollLine(0, 1) }
    Shortcut { sequence: "Left"; onActivated: conversation.scrollLine(-1, 0) }
    Shortcut { sequence: "Right"; onActivated: conversation.scrollLine(1, 0) }
    Shortcut { sequence: "Ctrl+H"; onActivated: conversation.scrollLine(-1, 0) }
    Shortcut { sequence: "Ctrl+J"; onActivated: conversation.scrollLine(0, 1) }
    Shortcut { sequence: "Ctrl+K"; onActivated: conversation.scrollLine(0, -1) }
    Shortcut { sequence: "Ctrl+L"; onActivated: conversation.scrollLine(1, 0) }
    Shortcut { sequence: "Ctrl+U"; onActivated: conversation.scrollPage(-1) }
    Shortcut { sequence: "Ctrl+D"; onActivated: conversation.scrollPage(1) }
    Shortcut { sequence: "PageUp"; onActivated: conversation.scrollPage(-1) }
    Shortcut { sequence: "PageDown"; onActivated: conversation.scrollPage(1) }
    Shortcut { sequence: "Ctrl+="; onActivated: conversation.stepFontScale(0.1) }
    Shortcut { sequence: "Ctrl++"; onActivated: conversation.stepFontScale(0.1) }
    Shortcut { sequence: "Ctrl+-"; onActivated: conversation.stepFontScale(-0.1) }
    Shortcut { sequence: "Ctrl+0"; onActivated: conversation.resetFontScale() }
    Shortcut { sequence: "Ctrl+P"; onActivated: conversation.pinConversation() }
  }

  function submit() {
    var text = prompt.text.trim()
    if (text === "" || waiting || sessionLost) return
    // Someone who scrolled up to read history keeps their position; only a
    // reader already at the tail gets pulled to the new prompt.
    var followTail = isAtEnd()
    waiting = true
    statusText = "Thinking…"
    queuedPrompt = text
    prompt.text = ""
    messages.append({ role: "You", body: text })
    var promptIndex = messages.count - 1
    activeReply = messages.count
    activeReplyMessageId = ""
    messages.append({ role: "Claude", body: "" })
    if (followTail) Qt.callLater(function() { root.anchorPrompt(promptIndex) })
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
    WindowShortcuts { conversation: root }
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
      // Optical centre, not the mathematical one. A card placed at exactly
      // half the free space reads as sitting low, because the eye weights the
      // gap beneath it more heavily than the gap above. Giving the top gap
      // the smaller share lifts it to where it looks centred.
      readonly property real opticalCentre: 0.38
      y: root.pinned
        ? 0
        : Math.max(Style.gapsOut, Math.round((parent.height - height) * opticalCentre))
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
        contentHeight: stack.height + root.tailSpace
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
        // The anchor travels further than a scroll step, so it is given its
        // own longer glide and is tracked separately from the stepping ones.
        NumberAnimation {
          id: anchorScroll
          target: surface
          property: "contentY"
          duration: 320
          easing.type: Easing.OutCubic
        }

        // Declared inside a Flickable, a handler attaches to the content item,
        // which covers the viewport exactly when there is something to scroll.
        // Mouse notches drive the same animated step the keys use; trackpads
        // keep the Flickable's own pixel-precise handling.
        WheelHandler {
          target: null
          acceptedDevices: PointerDevice.Mouse
          onWheel: function(event) {
            var steps = event.angleDelta.y / 120
            var sideways = event.angleDelta.x / 120
            if (steps === 0 && sideways === 0) return
            root.scrollLine(-sideways * 3, -steps * 3)
          }
        }

        Column {
          id: stack
          width: surface.width
          spacing: Style.space(4)

          Repeater {
            id: messageRepeater
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
                  if (root.handleFontKey(event) || root.handlePinKey(event) || root.handleScrollKey(event)) event.accepted = true
                }
              }
              TextEdit {
                id: agentText
                visible: !turn.human
                width: parent.width
                height: contentHeight
                text: root.spacedMarkdown(turn.body)
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
                  if (root.handleFontKey(event) || root.handlePinKey(event) || root.handleScrollKey(event)) event.accepted = true
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
                // Bare Down/Up walk the results while they are showing. The
                // caret keeps them otherwise, and Ctrl+J/K still scroll the
                // transcript, so nothing is taken away.
                if (root.menuOpen && !(event.modifiers & Qt.ControlModifier)
                    && (event.key === Qt.Key_Down || event.key === Qt.Key_Up)) {
                  root.menuMove(event.key === Qt.Key_Down ? 1 : -1)
                  event.accepted = true
                  return
                }
                if (event.key === Qt.Key_Escape && root.menuSelected) {
                  root.menuIndex = -1
                  event.accepted = true
                  return
                }
                if (root.handleFontKey(event) || root.handlePinKey(event) || root.handleScrollKey(event)) {
                  event.accepted = true
                } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                    && !(event.modifiers & Qt.ShiftModifier)) {
                  // A selection runs; no selection submits. Never inferred.
                  if (!root.menuActivate()) root.submit()
                  event.accepted = true
                }
              }
            }

            Text {
              id: promptMarker
              anchors.verticalCenter: prompt.verticalCenter
              // A small filled square rather than a chevron: it reads as a
              // marker instead of a shell prompt, which matters now that the
              // box is a search field as much as it is a composer.
              text: "\u25AA"
              color: root.accent
              font.family: Style.font.family
              font.pixelSize: prompt.responsiveFontSize
            }
          }

          // Drops below the composer, Spotlight-style. Sized to its rows so
          // it takes no space at all when nothing matches.
          Column {
            id: menuResults
            width: stack.width
            visible: root.menuOpen
            spacing: 0

            // The composer centres the prompt, so the space below the text is
            // already equal to the space above it -- but a hard rule reads
            // tighter than text does, and the line sat close. Drop it by the
            // composer's own top padding again, which keeps it proportional
            // as the type scales instead of pinning it to a constant.
            Item {
              width: 1
              height: Math.max(Style.space(6),
                               Math.round((composer.height - prompt.height) / 2))
            }

            Rectangle {
              width: parent.width
              height: 1
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.14)
            }

            // Each row carries half of Style.space(16) above its text and half
            // below, so neighbours sit a full space(16) apart. The first row
            // only had its own half against the rule, which read as crowded.
            // The other half is added here, plus a few px: matching the
            // inter-row gap exactly still read tight under a hard rule.
            Item { width: 1; height: Style.space(11) }

            Repeater {
              model: root.menuOpen ? menuSearch.rows : []
              delegate: Rectangle {
                required property var modelData
                required property int index
                readonly property bool current: index === root.menuIndex
                width: menuResults.width
                height: rowText.implicitHeight + Style.space(16)
                color: current
                  ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.18)
                  : "transparent"

                // Menu rows carry a glyph in their own icon font; applications
                // carry a real icon, resolved by the same AppLibrary the
                // launcher uses. One column, either kind.
                Item {
                  id: rowIcon
                  x: Style.space(6)
                  // Optically centred, not mathematically. A line box carries
                  // descender space the title glyphs mostly do not use, so
                  // splitting it evenly parks the icon visibly low against the
                  // text it labels. Lift it by a fraction of the type size.
                  y: rowText.y
                     + Math.round((rowTitle.implicitHeight - height) / 2)
                     - Math.round(root.menuTitleSize * 0.09)
                  width: root.menuTitleSize
                  height: width

                  Text {
                    anchors.centerIn: parent
                    visible: !modelData.isApp
                    text: modelData.icon || ""
                    color: parent.parent.current ? root.accent : root.foreground
                    font.family: modelData.iconFont && modelData.iconFont.length > 0
                      ? modelData.iconFont
                      : Style.font.family
                    font.pixelSize: Math.round(root.menuTitleSize * 0.8)
                  }
                  Image {
                    anchors.fill: parent
                    visible: modelData.isApp
                    source: modelData.isApp && root.appLibrary
                      ? root.appLibrary.iconSource(modelData.appIcon)
                      : ""
                    sourceSize.width: root.menuTitleSize
                    sourceSize.height: root.menuTitleSize
                    fillMode: Image.PreserveAspectFit
                    smooth: true
                  }
                }

                Column {
                  id: rowText
                  x: rowIcon.x + rowIcon.width + Style.space(10)
                  width: parent.width - x - Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(1)

                  Text {
                    id: rowTitle
                    width: parent.width
                    text: modelData.label
                    color: parent.parent.current ? root.accent : root.foreground
                    font.family: Style.font.family
                    font.pixelSize: root.menuTitleSize
                    elide: Text.ElideRight
                  }
                  Text {
                    width: parent.width
                    visible: String(modelData.path || "") !== ""
                    text: modelData.path
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45)
                    font.family: Style.font.family
                    font.pixelSize: root.menuPathSize
                    elide: Text.ElideRight
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  // A move arms hovering and selects in the same gesture, so
                  // the first twitch of the mouse still lands on this row.
                  onPositionChanged: {
                    root.menuMouseArmed = true
                    root.menuIndex = index
                  }
                  onEntered: if (root.menuMouseArmed) root.menuIndex = index
                  // A click is deliberate, so it never waits to be armed.
                  onClicked: { root.menuIndex = index; root.menuActivate() }
                }
              }
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

    // No Escape shortcut here on purpose. A pinned conversation is a real
    // toplevel window, so it closes the way every other window does, through
    // the window manager. Closing it on Escape made a normal window behave
    // like the overlay it was pinned out of, and took the key away from
    // anything inside that might want it. The overlay keeps its Escape.
    WindowShortcuts { conversation: root }
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
