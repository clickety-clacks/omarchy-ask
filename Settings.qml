import QtQuick
import "ShortcutPolicy.js" as ShortcutPolicy
import QtQuick.Controls
import Quickshell
import qs.Commons

// All of Ask's settings in one ordinary window (Ctrl+,): the agent for new
// conversations, the optional Agentd Hub, and the scroll-motion curve. A real
// window, so the compositor moves, scales and stacks it like any other.
//
// Choices apply as they are made. The hub address is typed, so it commits on
// Return or when the window closes with Ctrl+, or its close control; Escape
// closes and leaves the hub as it was.
FloatingWindow {
  id: root
  visible: false
  title: "Ask Settings"
  color: Color.menu.background
  implicitWidth: 600
  implicitHeight: 860
  minimumSize: Qt.size(480, 520)

  // Agent
  property string agent: "codex"
  property string model: "gpt-6-astra"
  property string reasoningEffort: "low"
  readonly property var modelChoices: agent === "claude" ? [
    { label: "Opus 4.8", value: "claude-opus-4-8" },
    { label: "Opus 5", value: "claude-opus-5" },
    { label: "Fable 5", value: "claude-fable-5" },
    { label: "Fable 5.1", value: "claude-fable-5-1" }
  ] : [
    { label: "Luna", value: "gpt-5.6-luna" },
    { label: "Terra", value: "gpt-5.6-terra" },
    { label: "Sol (GPT-5.6)", value: "gpt-5.6-sol" },
    { label: "Astra", value: "gpt-6-astra" }
  ]
  signal agentApplied(string agent, string model, string reasoningEffort)

  // Scroll motion and hub
  property real impulse: 335
  property real deceleration: 608
  property string hubHost: ""
  property int hubPort: 0
  property string openingHubHost: ""
  property int openingHubPort: 0
  property bool hubCommitted: false
  readonly property real duration: impulse / deceleration
  readonly property real distance: impulse * impulse / (2 * deceleration)
  signal motionChanged(real impulse, real deceleration)
  signal resetRequested()
  signal hubChanged(string host, int port)

  ShortcutScope {
    id: settingsScope
    targetWindow: root
    surfaceName: root.title
    chords: ShortcutPolicy.settings()
  }

  function open() {
    openingHubHost = hubHost
    openingHubPort = hubPort
    hubHostBox.input.text = hubHost
    hubPortBox.input.text = hubPort > 0 ? String(hubPort) : ""
    hubCommitted = false
    syncModelIndex()
    visible = true
    curve.requestPaint()
    Qt.callLater(function() {
      if (!root.visible) return
      var window = settingsScope.nativeWindow
      if (window) window.requestActivate()
      modelSelect.forceActiveFocus()
    })
  }

  // Ctrl+, or the window's own close: keep what was typed.
  function finish() {
    commitHub()
    visible = false
  }

  // Escape: leave the hub as it was when the window opened.
  function cancel() {
    hubCommitted = true
    hubHostBox.input.text = openingHubHost
    hubPortBox.input.text = openingHubPort > 0 ? String(openingHubPort) : ""
    if (hubHost !== openingHubHost || hubPort !== openingHubPort)
      hubChanged(openingHubHost, openingHubPort)
    visible = false
  }

  onVisibleChanged: {
    // Closed by the compositor (the window's close control): same as Ctrl+,.
    if (!visible && !hubCommitted) commitHub()
  }

  function syncModelIndex() {
    if (agent === "") { modelSelect.currentIndex = -1; return }
    for (var i = 0; i < modelChoices.length; i++) {
      if (modelChoices[i].value === model) {
        modelSelect.currentIndex = i
        return
      }
    }
    modelSelect.currentIndex = 0
  }

  function chooseAgent(nextAgent) {
    if (agent === nextAgent) return
    if (nextAgent === "") {
      agentApplied("", "", "")
    } else {
      agentApplied(nextAgent, nextAgent === "claude" ? "claude-opus-5" : "gpt-6-astra",
        reasoningEffort === "" ? "low" : reasoningEffort)
    }
    Qt.callLater(root.syncModelIndex)
  }

  function hubHostInput() { return hubHostBox.input }

  function normalizedHubPort(value) {
    var port = Number(value)
    if (!isFinite(port) || port <= 0) return 0
    return Math.round(Math.max(1, Math.min(65535, port)))
  }

  function commitHub() {
    hubCommitted = true
    var nextHost = String(hubHostBox.input.text || "").trim()
    var nextPort = normalizedHubPort(hubPortBox.input.text)
    if (nextHost !== hubHost || nextPort !== hubPort) hubChanged(nextHost, nextPort)
    openingHubHost = nextHost
    openingHubPort = nextPort
  }

  function setFromEndpoint(seconds, pixels) {
    var t = Math.max(0.08, Math.min(2.5, seconds))
    var d = Math.max(4, Math.min(600, pixels))
    // s(t) = v₀t - ½at², with v(t)=0 at the endpoint.
    // Therefore v₀=2s/t and a=2s/t².
    motionChanged(2 * d / t, 2 * d / (t * t))
  }

  Shortcut { sequence: "Escape"; onActivated: root.cancel() }
  Shortcut { sequence: "Ctrl+,"; onActivated: root.finish() }

  component Heading: Text {
    color: Color.menu.text
    font.family: Style.font.family
    font.pixelSize: Style.font.title
    font.bold: true
  }
  component Caption: Text {
    width: parent.width
    color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.58)
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }
  component Label: Text {
    color: Color.menu.text
    font.family: Style.font.family
    font.pixelSize: Style.font.body
  }
  component Choice: Rectangle {
    property string label
    property bool selected
    signal chosen()
    width: choiceLabel.implicitWidth + Style.space(22)
    height: Style.space(34)
    radius: Style.cornerRadius
    color: selected ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18) : "transparent"
    border.color: selected ? Color.accent : Color.menu.border
    Text {
      id: choiceLabel
      anchors.centerIn: parent
      text: parent.label
      color: Color.menu.text
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: parent.chosen() }
  }
  component Field: Rectangle {
    property alias input: field
    property string placeholder
    height: Style.space(38)
    color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.05)
    border.color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.20)
    radius: Style.cornerRadius
    TextInput {
      id: field
      anchors.fill: parent
      anchors.margins: Style.space(9)
      color: Color.menu.text
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      clip: true
      selectByMouse: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          root.cancel(); event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          root.commitHub(); event.accepted = true
        }
      }
      Text {
        anchors.fill: parent
        visible: !parent.text && !parent.activeFocus
        text: parent.parent.placeholder
        color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.42)
        font: parent.font
      }
    }
  }

  Flickable {
    anchors.fill: parent
    contentHeight: content.implicitHeight + Style.space(56)
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: content
      x: Style.space(28)
      y: Style.space(28)
      width: parent.width - Style.space(56)
      spacing: Style.space(14)

      // --- Agent ---------------------------------------------------------
      Heading { text: "Agent" }
      Caption { text: "Applies to new conversations and survives shell restarts." }
      Row {
        spacing: Style.space(8)
        Repeater {
          model: ["", "codex", "claude"]
          delegate: Choice {
            required property string modelData
            label: modelData || "Omarchy default"
            selected: root.agent === modelData
            onChosen: root.chooseAgent(modelData)
          }
        }
      }
      Label { text: "Model" }
      ComboBox {
        id: modelSelect
        enabled: root.agent !== ""
        displayText: root.agent === "" ? "System harness settings" : currentText
        width: parent.width
        height: Style.space(42)
        model: root.modelChoices
        textRole: "label"
        valueRole: "value"
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        onActivated: root.agentApplied(root.agent, currentValue, root.reasoningEffort)
      }
      Label { text: "Thinking" }
      Row {
        spacing: Style.space(7)
        enabled: root.agent !== ""
        opacity: enabled ? 1 : 0.5
        Repeater {
          model: ["low", "medium", "high", "xhigh", "max"]
          delegate: Choice {
            required property string modelData
            label: modelData
            selected: root.reasoningEffort === modelData
            onChosen: root.agentApplied(root.agent, root.model, modelData)
          }
        }
      }

      Item { width: 1; height: Style.space(10) }

      // --- Agentd Hub ----------------------------------------------------
      Heading { text: "Agentd Hub" }
      Caption { text: "Optional. Lists running agents in Ask's search. Return saves the address." }
      Row {
        width: parent.width
        spacing: Style.space(10)
        Field {
          id: hubHostBox
          width: parent.width - hubPortBox.width - parent.spacing
          placeholder: "hub address"
        }
        Field {
          id: hubPortBox
          width: Style.space(100)
          placeholder: "port"
          input.inputMethodHints: Qt.ImhDigitsOnly
          input.validator: IntValidator { bottom: 1; top: 65535 }
        }
      }

      Item { width: 1; height: Style.space(10) }

      // --- Scroll motion -------------------------------------------------
      Heading { text: "Scroll motion" }
      Caption {
        text: "Drag the endpoint. Right means a longer coast; up means farther travel. The curve is the viewport’s position after one navigation-key impulse."
      }
      Rectangle {
        id: graph
        width: parent.width
        height: Style.space(300)
        color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.035)
        border.color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.14)
        border.width: 1
        radius: Style.cornerRadius

        Canvas {
          id: curve
          anchors.fill: parent
          property real leftPad: Style.space(48)
          property real rightPad: Style.space(24)
          property real topPad: Style.space(24)
          property real bottomPad: Style.space(42)
          readonly property real plotWidth: width - leftPad - rightPad
          readonly property real plotHeight: height - topPad - bottomPad
          readonly property real endX: leftPad + Math.min(1, root.duration / 2.5) * plotWidth
          readonly property real endY: height - bottomPad - Math.min(1, root.distance / 600) * plotHeight

          onWidthChanged: requestPaint()
          onHeightChanged: requestPaint()
          Connections {
            target: root
            function onImpulseChanged() { curve.requestPaint() }
            function onDecelerationChanged() { curve.requestPaint() }
          }

          onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            var bottom = height - bottomPad
            var right = width - rightPad

            ctx.lineWidth = 1
            ctx.strokeStyle = Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.18)
            ctx.beginPath()
            ctx.moveTo(leftPad, topPad)
            ctx.lineTo(leftPad, bottom)
            ctx.lineTo(right, bottom)
            ctx.stroke()

            ctx.lineWidth = Math.max(2, Style.space(2))
            ctx.strokeStyle = Color.accent
            ctx.beginPath()
            for (var index = 0; index <= 48; index++) {
              var u = index / 48
              var seconds = root.duration * u
              var pixels = root.impulse * seconds
                - 0.5 * root.deceleration * seconds * seconds
              var x = leftPad + (seconds / 2.5) * plotWidth
              var y = bottom - (pixels / 600) * plotHeight
              if (index === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            }
            ctx.stroke()

            ctx.fillStyle = Color.accent
            ctx.beginPath()
            ctx.arc(endX, endY, Style.space(7), 0, Math.PI * 2)
            ctx.fill()
          }

          MouseArea {
            anchors.fill: parent
            preventStealing: true
            cursorShape: pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor
            onPressed: function(mouse) { update(mouse.x, mouse.y) }
            onPositionChanged: function(mouse) { if (pressed) update(mouse.x, mouse.y) }
            function update(x, y) {
              var seconds = (x - curve.leftPad) / curve.plotWidth * 2.5
              var pixels = (curve.height - curve.bottomPad - y) / curve.plotHeight * 600
              root.setFromEndpoint(seconds, pixels)
            }
          }
        }

        Text {
          anchors.left: parent.left
          anchors.bottom: parent.bottom
          anchors.leftMargin: Style.space(10)
          anchors.bottomMargin: Style.space(10)
          text: "distance"
          color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.42)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
        Text {
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.rightMargin: Style.space(12)
          anchors.bottomMargin: Style.space(10)
          text: "time →"
          color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.42)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }
      Row {
        width: parent.width
        spacing: Style.space(22)
        Label { text: "impulse  " + Math.round(root.impulse) + " px/s" }
        Label { text: "friction  " + Math.round(root.deceleration) + " px/s²" }
        Label { text: root.distance.toFixed(0) + " px · " + root.duration.toFixed(2) + " s"; color: Color.accent }
      }
      Choice { label: "Reset"; selected: false; onChosen: root.resetRequested() }
    }
  }

}
