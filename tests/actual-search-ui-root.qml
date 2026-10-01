// Disposable UI probe for the nested Wayland acceptance run. It uses the real
// Ask/Conversation/MenuSearch types and the deterministic fake bridge only.
import QtQuick
import Quickshell
import Quickshell.Io
import "ask" as AskPlugin

Scope {
  id: root

  AskPlugin.Ask { id: manager }

  property var conversation: null
  property var search: null
  property var prompt: null
  property var browsed: []
  property string lastLaunch: ""

  function descendants(item, seen) {
    var found = []
    if (!item) return found
    if (!seen) seen = []
    if (seen.indexOf(item) >= 0) return found
    seen.push(item)
    var lists = [item.children || [], item.data || []]
    for (var list = 0; list < lists.length; list++) {
      for (var i = 0; i < lists[list].length; i++) {
        var child = lists[list][i]
        if (seen.indexOf(child) >= 0) continue
        found.push(child)
        found = found.concat(descendants(child, seen))
      }
    }
    return found
  }

  function locate() {
    conversation = manager.activeOverlay
    if (!conversation) return false
    var objects = descendants(conversation)
    for (var i = 0; i < objects.length; i++) {
      var object = objects[i]
      if (object && typeof object.run === "function") search = object
      if (object && object.placeholderText !== undefined
          && object.text !== undefined) {
        if (!prompt || object.width > prompt.width) prompt = object
      }
    }
    return Boolean(search && prompt)
  }

  function fakeApps() {
    return {
      sortedEntries: function(value) {
        var needle = String(value || "").toLowerCase()
        var app = { id: "ui-fixture-app", name: "ui-fixture app",
          subtext: "fixture application", icon: "" }
        return app.name.indexOf(needle) >= 0 ? [{ entry: app }] : []
      },
      entryName: function(app) { return app.name },
      entrySubtext: function(app) { return app.subtext },
      iconSource: function() { return "" },
      launch: function(id) { root.lastLaunch = String(id || "") }
    }
  }

  function fixtureAgents() {
    return [{ name: "ui-fixture agent", machine: "fixture-host",
      instanceId: "fixture-instance", id: { pid: 71, startTimeTicks: 91 },
      activity: { state: "idle" }, presence: { state: "present" } }]
  }

  function configureFixtures() {
    if (!locate()) return false
    search.debounceMs = 100000
    search.query = "ui-fixture"
    search.appLibrary = fakeApps()
    search.agentRows = fixtureAgents()
    search.fileRows = [{ name: "ui-fixture file", relativePath: "fixture/file",
      path: "/tmp/ui-fixture-file" }]
    search.fileMatchCount = 1
    search.repoRows = [{ name: "ui-fixture repo", relativePath: "fixture/repo",
      path: "/tmp/ui-fixture-repo" }]
    search.repoMatchCount = 1
    search.windowRows = [{ title: "ui-fixture window", stableId: "ui-1",
      workspace: "1", class: "fixture", score: 0 }]
    search.windowMatchCount = 1
    search.items = ({})
    search.itemOrder = []
    search.refreshRows()
    return true
  }

  function openPrompt() {
    if (!manager.activeOverlay) manager.open("{}")
    Qt.callLater(function() {
      if (!configureFixtures()) locateTimer.restart()
    })
  }

  function rowsState() {
    if (!locate()) return "{}"
    var messageCount = -1
    var messageObjects = descendants(conversation)
    for (var m = 0; m < messageObjects.length; m++) {
      if (messageObjects[m] && messageObjects[m].count !== undefined
          && typeof messageObjects[m].get === "function") {
        messageCount = Number(messageObjects[m].count)
        break
      }
    }
    return JSON.stringify({
      rows: search.rows.map(function(row) {
        return { id: String(row.id || ""), aggregate: row.aggregateBucket || "",
          label: String(row.label || "") }
      }), searchMode: conversation.searchMode,
      focusedBucket: search.focusedBucket,
      prompt: prompt.text, browsed: root.browsed,
      launch: root.lastLaunch,
      waiting: conversation.waiting,
      bridgeReady: conversation.bridgeReady,
      statusText: conversation.statusText,
      messageCount: messageCount
    })
  }

  function settingsInputs() {
    var objects = descendants(manager)
    var tuner = null
    for (var t = 0; t < objects.length; t++) {
      var candidate = objects[t]
      if (candidate && candidate.hubHost !== undefined
          && candidate.hubPort !== undefined
          && candidate.openingHubHost !== undefined) {
        tuner = candidate
        break
      }
    }
    if (tuner) objects = descendants(tuner)
    var host = null
    var port = null
    for (var i = 0; i < objects.length; i++) {
      var object = objects[i]
      if (!object || object.cursorPosition === undefined
          || object.text === undefined || object.width === undefined) continue
      if (object.width > 200 && !host) host = object
      else if (object.width > 50 && object.width < 180 && !port) port = object
    }
    return { host: host, port: port }
  }

  function focusPort() {
    var inputs = settingsInputs()
    if (!inputs.port) return false
    inputs.port.forceActiveFocus()
    inputs.port.cursorPosition = inputs.port.length
    return true
  }

  function focusHost() {
    var inputs = settingsInputs()
    if (!inputs.host) return false
    inputs.host.forceActiveFocus()
    inputs.host.cursorPosition = inputs.host.length
    return true
  }

  function settingsState() {
    var objects = descendants(manager)
    var tuner = null
    for (var i = 0; i < objects.length; i++) {
      var object = objects[i]
      if (object && object.hubHost !== undefined
          && object.hubPort !== undefined
          && object.openingHubHost !== undefined) {
        tuner = object
        break
      }
    }
    var inputs = settingsInputs()
    return JSON.stringify({
      visible: Boolean(tuner && tuner.visible),
      host: tuner ? String(tuner.hubHost) : "",
      port: tuner ? Number(tuner.hubPort) : 0,
      openingHost: tuner ? String(tuner.openingHubHost) : "",
      openingPort: tuner ? Number(tuner.openingHubPort) : 0,
      hostText: inputs.host ? String(inputs.host.text) : "",
      portText: inputs.port ? String(inputs.port.text) : ""
    })
  }

  function activate(bucket) {
    if (!locate()) return false
    for (var i = 0; i < search.rows.length; i++) {
      if (search.rows[i].isAggregate && search.rows[i].aggregateBucket === bucket) {
        conversation.menuIndex = i
        return conversation.menuActivate(Qt.NoModifier)
      }
    }
    return false
  }

  function clearScope() {
    if (!locate()) return false
    prompt.text = ""
    return true
  }

  Connections {
    target: root.search
    function onBrowseRequested(mode, query) {
      root.browsed = root.browsed.concat([{ mode: mode, query: query }])
    }
  }

  Timer {
    id: locateTimer
    interval: 100
    repeat: true
    running: true
    onTriggered: {
      if (root.configureFixtures()) stop()
    }
  }

  IpcHandler {
    target: "askSearchUiTest"
    function openPrompt(): void { root.openPrompt() }
    function debug(): string {
      var active = manager.activeOverlay
      var objects = active ? root.descendants(active) : []
      var runCount = 0
      var queryCount = 0
      var textCount = 0
      var promptCandidateCount = 0
      for (var i = 0; i < objects.length; i++) {
        runCount += typeof objects[i].run === "function" ? 1 : 0
        queryCount += objects[i].query !== undefined ? 1 : 0
        textCount += objects[i].text !== undefined ? 1 : 0
        promptCandidateCount += objects[i].placeholderText !== undefined
          && objects[i].text !== undefined ? 1 : 0
      }
      return JSON.stringify({ conversation: Boolean(active),
        children: active && active.children ? active.children.length : -1,
        descendants: objects.length, runCount: runCount,
        queryCount: queryCount, textCount: textCount,
        promptCandidateCount: promptCandidateCount,
        search: Boolean(root.search), prompt: Boolean(root.prompt),
        query: root.search ? String(root.search.query) : "",
        files: root.search ? root.search.fileRows.length : -1,
        repos: root.search ? root.search.repoRows.length : -1,
        windows: root.search ? root.search.windowRows.length : -1,
        agents: root.search ? root.search.agentRows.length : -1 })
    }
    function state(): string { return root.rowsState() }
    function settings(): string { return root.settingsState() }
    function focusHost(): bool { return root.focusHost() }
    function focusPort(): bool { return root.focusPort() }
    function activate(bucket: string): string {
      return JSON.stringify({ ok: root.activate(bucket), state: JSON.parse(root.rowsState()) })
    }
    function clearScope(): void { root.clearScope() }
    function closePrompts(): void { manager.closeAll() }
  }
}
