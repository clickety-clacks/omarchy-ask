import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Wayland
import qs.Commons

PanelWindow {
  id: root
  visible: false
  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  WlrLayershell.namespace: "omarchy-ask-harness"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: visible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
  exclusionMode: ExclusionMode.Ignore
  mask: Region { item: card }

  property string agent: "codex"
  property string model: "gpt-6-astra"
  property string reasoningEffort: "low"
  property string draftAgent: agent
  property string draftModel: model
  property string draftReasoningEffort: reasoningEffort
  readonly property var modelChoices: draftAgent === "claude" ? [
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
  signal applied(string agent, string model, string reasoningEffort)

  function open() {
    draftAgent = agent
    draftModel = model
    draftReasoningEffort = reasoningEffort
    syncModelIndex()
    visible = true
    Qt.callLater(function() { modelSelect.forceActiveFocus() })
  }

  function syncModelIndex() {
    if (draftAgent === "") { modelSelect.currentIndex = -1; return }
    for (var i = 0; i < modelChoices.length; i++) {
      if (modelChoices[i].value === draftModel) {
        modelSelect.currentIndex = i
        return
      }
    }
    modelSelect.currentIndex = 0
    draftModel = modelChoices[0].value
  }

  function chooseAgent(nextAgent) {
    if (draftAgent === nextAgent) return
    draftAgent = nextAgent
    if (nextAgent === "") {
      draftModel = ""
      draftReasoningEffort = ""
      modelSelect.currentIndex = -1
      return
    }
    if (draftReasoningEffort === "") draftReasoningEffort = "low"
    draftModel = nextAgent === "claude" ? "claude-opus-5" : "gpt-6-astra"
    Qt.callLater(root.syncModelIndex)
  }

  function commit() {
    applied(draftAgent, draftModel, draftReasoningEffort)
    visible = false
  }

  Shortcut { sequence: "Escape"; onActivated: root.visible = false }
  Shortcut { sequence: "Meta+,"; onActivated: root.visible = false }
  Shortcut { sequence: "Return"; onActivated: root.commit() }

  Rectangle {
    id: card
    width: Math.min(Style.space(520), parent.width - Style.gapsOut * 2)
    height: content.implicitHeight + Style.space(52)
    anchors.centerIn: parent
    color: Color.menu.background
    border.color: Color.menu.border
    border.width: Math.max(1, Style.space(2))
    radius: Style.cornerRadius

    Column {
      id: content
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(26)
      spacing: Style.space(14)

      Text { text: "Agent"; color: Color.menu.text; font.family: Style.font.family; font.pixelSize: Style.font.title; font.bold: true }
      Text {
        width: parent.width
        text: "Applies to new conversations and survives shell restarts."
        color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.58)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
      }

      Row {
        spacing: Style.space(8)
        Repeater {
          model: ["", "codex", "claude"]
          delegate: Rectangle {
            required property string modelData
            width: harnessLabel.implicitWidth + Style.space(24)
            height: Style.space(36)
            radius: Style.cornerRadius
            color: root.draftAgent === modelData ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18) : "transparent"
            border.color: root.draftAgent === modelData ? Color.accent : Color.menu.border
            Text { id: harnessLabel; anchors.centerIn: parent; text: modelData || "Omarchy default"; color: Color.menu.text; font.family: Style.font.family; font.pixelSize: Style.font.body }
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.chooseAgent(modelData) }
          }
        }
      }

      Text { text: "Model"; color: Color.menu.text; font.family: Style.font.family; font.pixelSize: Style.font.body }
      ComboBox {
        id: modelSelect
        enabled: root.draftAgent !== ""
        displayText: root.draftAgent === "" ? "System harness settings" : currentText
        width: parent.width
        height: Style.space(42)
        model: root.modelChoices
        textRole: "label"
        valueRole: "value"
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        onActivated: root.draftModel = currentValue
      }

      Text { text: "Thinking"; color: Color.menu.text; font.family: Style.font.family; font.pixelSize: Style.font.body }
      Row {
        spacing: Style.space(7)
        enabled: root.draftAgent !== ""
        Repeater {
          model: ["low", "medium", "high", "xhigh", "max"]
          delegate: Rectangle {
            required property string modelData
            width: effortLabel.implicitWidth + Style.space(18)
            height: Style.space(34)
            radius: Style.cornerRadius
            color: root.draftReasoningEffort === modelData ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18) : "transparent"
            border.color: root.draftReasoningEffort === modelData ? Color.accent : Color.menu.border
            Text { id: effortLabel; anchors.centerIn: parent; text: modelData; color: Color.menu.text; font.family: Style.font.family; font.pixelSize: Style.font.caption }
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.draftReasoningEffort = modelData }
          }
        }
      }

      Text { text: "Return to save"; color: Color.accent; font.family: Style.font.family; font.pixelSize: Style.font.caption }
    }
  }
}
