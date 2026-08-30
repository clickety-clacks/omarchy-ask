// Omarchy menu rows, searchable from the Ask composer.
//
// This deliberately owns no model of its own. The menu's rows, merge rules,
// guard evaluation, ranking and ✓ marks all come from the shell's own
// MenuModel.js, so anything that reconfigures the Omarchy menu -- an edit to
// either JSONC file, a plugin, an agent, an Omarchy update -- reconfigures
// this at the same moment and with identical semantics. Reimplementing any of
// it here would be a second definition of the same thing, free to drift.
//
// Search is flat on purpose. The composer is a search box, not a place to
// walk a tree, so all leaf rows compete at once and each carries its own
// path as context.

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "file:///usr/share/omarchy/shell/plugins/menu/MenuModel.js" as MenuModel

Item {
  id: root

  readonly property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"
  readonly property string defaultMenuPath: omarchyPath + "/default/omarchy/omarchy-menu.jsonc"
  readonly property string userMenuPath: Quickshell.env("HOME") + "/.config/omarchy/extensions/omarchy-menu.jsonc"

  property var defaultMenuItems: []
  property var userMenuItems: []
  property var items: ({})
  property var itemOrder: []
  property var whenResults: ({})
  property var checkedResults: ({})

  // What the composer is asking about, and what it gets back.
  // Supplied by the conversation, which gets it from the shell. Without it
  // only menu rows are searchable; applications are simply absent.
  property var appLibrary: null
  property string query: ""
  property int maxRows: 8
  // Matching is cheap, but every change to the row count resizes the card,
  // and the card animates its height. Recomputing per keystroke therefore
  // made fast typing look like the window was flinching. Wait for a pause in
  // typing and resize once, on what was actually typed.
  property int debounceMs: 270
  readonly property bool hasResults: rows.length > 0
  property var rows: []
  property var mathRow: null
  property int mathRequestId: 0
  property var fileRows: []
  property int fileMatchCount: 0
  property bool fileMatchCapped: false
  property bool fileMatchComplete: true
  property var repoRows: []
  property int repoMatchCount: 0
  property bool repoMatchCapped: false
  property bool repoMatchComplete: true
  property var windowRows: []
  property int fileRequestId: 0
  property int windowRequestId: 0
  property bool fileMode: false
  property bool repoMode: false
  property string fileQueryOverride: ""
  property bool lastRunKeepsOpen: false

  signal actionRan(string label)
  signal browseRequested(string mode, string query)
  signal pathActionRequested(string path, bool repository, string verb)

  function rebuild() {
    var merged = MenuModel.mergeMenuSources(root.defaultMenuItems, root.userMenuItems)
    root.items = merged.items
    root.itemOrder = merged.itemOrder
    evaluateGuards()
    refreshRows()
  }

  // A row only competes if the menu itself would show it: a `when:` that
  // evaluated false hides it here exactly as it does there.
  function refreshRows() {
    var text = String(root.query || "").trim()
    if (text === "") { root.rows = []; return }
    var windowOnly = text.indexOf("%") === 0
    var fileOnly = text.indexOf("@") === 0
    var repoOnly = text.indexOf("^") === 0
    var focusedMode = windowOnly || fileOnly || repoOnly

    var scored = []
    // Math is a suggestion, not a routing mode. It always ranks first when a
    // deterministic parser finds an expression anywhere in the prose; the
    // original prompt still goes to ACP unless this row is deliberately
    // selected.
    if (!focusedMode && root.mathRow && root.mathRow.query === root.query) scored.push({
      id: "math:" + root.mathRequestId,
      label: root.mathRow.expression + " = " + root.mathRow.answer,
      path: "",
      icon: "",
      iconFont: "",
      isApp: false,
      isMath: true,
      equation: root.mathRow.expression + " =",
      answer: root.mathRow.answer,
      appIcon: "",
      appId: "",
      action: "",
      route: "",
      score: -2
    })
    if (!focusedMode && !root.fileMode && root.fileRows.length > 0) scored.push({
      id: "file-results",
      label: root.fileMatchCount + (root.fileMatchCapped ? "+" : "")
        + " matched files" + (!root.fileMatchCapped && !root.fileMatchComplete ? "…" : ""),
      path: "Files",
      icon: "󰈞",
      iconFont: "JetBrainsMono Nerd Font",
      isApp: false,
      isMath: false,
      isFileAggregate: true,
      appIcon: "", appId: "", action: "", route: "", score: -1
    })
    if (!focusedMode && !root.repoMode && root.repoRows.length > 0) scored.push({
      id: "repo-results",
      label: root.repoMatchCount + (root.repoMatchCapped ? "+" : "")
        + " matched git repos" + (!root.repoMatchCapped && !root.repoMatchComplete ? "…" : ""),
      path: "Repositories",
      icon: "󰊢",
      iconFont: "JetBrainsMono Nerd Font",
      isApp: false,
      isMath: false,
      isRepoAggregate: true,
      appIcon: "", appId: "", action: "", route: "", score: -0.9
    })
    for (var w = 0; !fileOnly && !repoOnly && w < root.windowRows.length
         && w < (windowOnly ? 40 : 3); w++) {
      var window = root.windowRows[w]
      scored.push({
        id: "window:" + window.stableId,
        label: window.title,
        path: (windowOnly ? "" : "Workspace " + window.workspace + " · ")
          + (window.detail ? window.detail + " · " : "") + window.class,
        workspace: String(window.workspace || ""),
        icon: "󰖯",
        iconFont: "JetBrainsMono Nerd Font",
        isApp: false,
        isMath: false,
        isWindow: true,
        stableId: window.stableId,
        appIcon: "", appId: "", action: "", route: "",
        score: -0.8 + Number(window.score || 0) * 0.01
      })
    }
    if (fileOnly || repoOnly) {
      var matches = repoOnly ? root.repoRows : root.fileRows
      for (var f = 0; f < matches.length; f++) {
        var match = matches[f]
        scored.push({
          id: (repoOnly ? "repo:" : "file:") + String(match.path || ""),
          label: match.name || match.path || "",
          path: match.relativePath || match.path || "",
          icon: repoOnly ? "󰊢" : "󰈞",
          iconFont: "JetBrainsMono Nerd Font",
          isApp: false,
          isMath: false,
          isPath: true,
          isRepository: repoOnly,
          absolutePath: String(match.path || ""),
          actionHint: repoOnly
            ? "↵ terminal  ·  Ctrl+↵ reveal  ·  Shift+↵ copy path"
            : "↵ view  ·  Ctrl+↵ reveal  ·  Alt+↵ edit  ·  Shift+↵ copy",
          appIcon: "", appId: "", action: "", route: "", score: f
        })
      }
      root.rows = scored
      return
    }
    if (windowOnly) {
      scored.sort(function(a, b) {
        var aNumber = Number(a.workspace)
        var bNumber = Number(b.workspace)
        var bothNumeric = isFinite(aNumber) && isFinite(bNumber)
        var workspaceOrder = bothNumeric ? aNumber - bNumber
          : String(a.workspace).localeCompare(String(b.workspace))
        return workspaceOrder || a.score - b.score || a.label.localeCompare(b.label)
      })
      var grouped = scored
      var priorWorkspace = ""
      for (var g = 0; g < grouped.length; g++) {
        grouped[g].workspaceHeader = grouped[g].workspace !== priorWorkspace
          ? "Workspace " + grouped[g].workspace : ""
        priorWorkspace = grouped[g].workspace
      }
      root.rows = grouped
      return
    }
    for (var i = 0; i < root.itemOrder.length; i++) {
      var id = root.itemOrder[i]
      var entry = root.items[id]
      if (!entry) continue
      // Submenus compete too. "install" should find Install, and choosing it
      // opens that menu rather than pretending a submenu is an action.
      if (!entry.action && !entry.target && entry.kind !== "menu") continue
      if (id === "root") continue
      var visible = MenuModel.isVisible(root.items, root.itemOrder, root.whenResults, entry)
      if (!visible) continue
      if (!MenuModel.matchesQuery(entry, text, visible)) continue
      scored.push({
        id: id,
        label: MenuModel.labelFor(entry, root.checkedResults),
        path: MenuModel.parentPathFor(root.items, id),
        icon: entry.icon || "",
        iconFont: entry.iconFont || "",
        isApp: false,
        appIcon: "",
        appId: "",
        action: entry.action || "",
        route: entry.action ? "" : id,
        score: MenuModel.searchScore(root.items, entry, text)
      })
    }

    // Applications come from the shell's own AppLibrary -- the same engine the
    // launcher and the menu's `apps` provider use -- so ATC, Element X and the
    // rest rank here exactly as they do there, icons included.
    if (root.appLibrary) {
      var appRows = root.appLibrary.sortedEntries(text)
      for (var a = 0; a < appRows.length && a < 40; a++) {
        var app = appRows[a].entry
        if (!app || root.appLibrary.isHiddenEntry(app)) continue
        var name = root.appLibrary.entryName(app)
        if (!name) continue
        var subtext = root.appLibrary.entrySubtext(app) || ""

        // Scored by the menu's own function rather than by position, so an
        // application competes in the same numeric space as a menu row and
        // the tiers interleave correctly. searchScore already knows about
        // `kind: "app"`. depthFor tolerates a map holding only this entry:
        // item() returns null for the missing parent and the walk stops.
        var appAliases = [subtext]
        try {
          if (app.keywords && typeof app.keywords.join === "function")
            appAliases = appAliases.concat(app.keywords)
        } catch (e) { }

        var appEntry = {
          id: "app:" + app.id,
          parent: "apps",
          kind: "app",
          label: name,
          aliases: appAliases,
          description: subtext,
          // AppLibrary already ranked these; keep that as the tiebreak within
          // a tier instead of discarding it.
          order: a
        }
        var appItems = ({})
        appItems[appEntry.id] = appEntry

        scored.push({
          id: appEntry.id,
          label: name,
          path: subtext || "Apps",
          icon: "",
          iconFont: "",
          isApp: true,
          appIcon: app.icon || "",
          appId: String(app.id || ""),
          action: "",
          route: "",
          score: MenuModel.searchScore(appItems, appEntry, text)
        })
      }
    }

    // Ascending: searchScore counts up from 0 for the best match, and it
    // already ranks a title hit above an alias hit above a description-only
    // hit. Sorting the other way put the weakest matches first.
    scored.sort(function(a, b) { return a.score - b.score })
    root.rows = scored.slice(0, root.maxRows)
  }

  function run(index, modifiers) {
    if (index < 0 || index >= root.rows.length) return false
    var row = root.rows[index]
    root.lastRunKeepsOpen = false
    if (row.isMath) {
      Quickshell.execDetached(["wl-copy", String(row.answer)])
    } else if (row.isFileAggregate || row.isRepoAggregate) {
      root.lastRunKeepsOpen = true
      root.browseRequested(row.isRepoAggregate ? "repos" : "files", root.query)
      return true
    } else if (row.isPath) {
      var flags = Number(modifiers || 0)
      var verb = (flags & Qt.ControlModifier) !== 0 ? "reveal"
        : ((flags & Qt.ShiftModifier) !== 0 ? "copy"
        : ((flags & Qt.AltModifier) !== 0 ? "edit" : "open"))
      root.pathActionRequested(row.absolutePath, Boolean(row.isRepository), verb)
    } else if (row.isApp) {
      if (!root.appLibrary) return false
      root.appLibrary.launch(row.appId, row.label)
    } else if (row.isWindow) {
      Quickshell.execDetached([
        "node",
        Quickshell.env("HOME") + "/.config/omarchy/plugins/clickety-clacks.ask/bridge/windows.js",
        "--focus", String(row.stableId || "")
      ])
    } else if (row.route) {
      // A submenu opens in the real menu. Reimplementing drill-down here
      // would be a second navigation model over the same rows.
      Util.execDetached("omarchy menu summon " + row.route)
    } else {
      Util.execDetached(String(row.action))
    }
    root.actionRan(row.label)
    return true
  }

  // Clearing the box collapses the list at once -- there is nothing to settle
  // on, and holding an empty result open for the debounce would just look
  // broken. Everything else waits for the pause.
  onQueryChanged: {
    if (String(root.query || "").trim() === "") {
      searchDebounce.stop()
      root.mathRow = null
      root.fileRows = []
      root.fileMatchCount = 0
      root.fileMatchCapped = false
      root.fileMatchComplete = true
      root.repoRows = []
      root.repoMatchCount = 0
      root.repoMatchCapped = false
      root.repoMatchComplete = true
      root.windowRows = []
      root.rows = []
      return
    }
    root.mathRequestId++
    if (mathProc.running) mathProc.write(JSON.stringify({
      id: root.mathRequestId,
      query: root.query
    }) + "\n")
    root.requestFiles()
    root.requestWindows()
    searchDebounce.restart()
  }

  onFileQueryOverrideChanged: if (root.fileMode || root.repoMode) root.requestFiles()
  onFileModeChanged: if (root.fileMode) root.requestFiles()
  onRepoModeChanged: if (root.repoMode) root.requestFiles()

  function requestFiles() {
    var focused = root.fileMode || root.repoMode
      || /^[@^]/.test(String(root.query || "").trim())
    var wanted = (root.fileMode || root.repoMode) ? root.fileQueryOverride : root.query
    wanted = String(wanted || "").replace(/^[@^]/, "").trim()
    // Rows belong to one query generation. Clear them before advancing the id
    // so the UI cannot briefly relabel the previous query's 100 results as
    // matches for the text that was just typed.
    root.fileRows = []
    root.fileMatchCount = 0
    root.fileMatchCapped = false
    root.fileMatchComplete = true
    root.repoRows = []
    root.repoMatchCount = 0
    root.repoMatchCapped = false
    root.repoMatchComplete = true
    root.fileRequestId++
    if (fileProc.running) fileProc.write(JSON.stringify({
      id: root.fileRequestId,
      query: wanted,
      focused: focused
    }) + "\n")
  }

  function acceptFiles(line) {
    try {
      var message = JSON.parse(String(line || ""))
      if (Number(message.id) !== root.fileRequestId) return
      if (message.repoOnly !== true) {
        root.fileRows = message.rows || []
        root.fileMatchCount = Number(message.totalMatched) || root.fileRows.length
        root.fileMatchCapped = message.capped === true
        root.fileMatchComplete = message.complete !== false
      }
      if (Array.isArray(message.repos)) {
        root.repoRows = message.repos
        root.repoMatchCount = Number(message.repoTotalMatched) || root.repoRows.length
        root.repoMatchCapped = message.repoCapped === true
        root.repoMatchComplete = message.repoComplete !== false
      }
      if (!root.fileMode && !root.repoMode) root.refreshRows()
    } catch (error) { }
  }

  function requestWindows() {
    var wanted = String(root.query || "").trim().replace(/^%/, "").trim()
    root.windowRequestId++
    if (windowProc.running) windowProc.write(JSON.stringify({
      id: root.windowRequestId, query: wanted
    }) + "\n")
  }

  function acceptWindows(line) {
    try {
      var message = JSON.parse(String(line || ""))
      if (Number(message.id) !== root.windowRequestId) return
      root.windowRows = message.rows || []
      root.refreshRows()
    } catch (error) { }
  }

  function acceptMath(line) {
    try {
      var message = JSON.parse(String(line || ""))
      if (Number(message.id) !== root.mathRequestId) return
      root.mathRow = message.result ? {
        query: String(message.query || ""),
        expression: String(message.result.expression || ""),
        answer: String(message.result.answer || "")
      } : null
      root.refreshRows()
    } catch (error) { }
  }

  Process {
    id: mathProc
    command: [
      "node",
      Quickshell.env("HOME") + "/.config/omarchy/plugins/clickety-clacks.ask/bridge/math.js"
    ]
    running: true
    stdinEnabled: true
    onStarted: if (String(root.query || "").trim() !== "")
      write(JSON.stringify({ id: root.mathRequestId, query: root.query }) + "\n")
    stdout: SplitParser { onRead: function(line) { root.acceptMath(line) } }
  }

  Process {
    id: fileProc
    command: [
      "node",
      Quickshell.env("HOME") + "/.config/omarchy/plugins/clickety-clacks.ask/bridge/files.js"
    ]
    running: true
    stdinEnabled: true
    onStarted: root.requestFiles()
    stdout: SplitParser { onRead: function(line) { root.acceptFiles(line) } }
  }

  Process {
    id: windowProc
    command: [
      "node",
      Quickshell.env("HOME") + "/.config/omarchy/plugins/clickety-clacks.ask/bridge/windows.js"
    ]
    running: true
    stdinEnabled: true
    onStarted: root.requestWindows()
    stdout: SplitParser { onRead: function(line) { root.acceptWindows(line) } }
  }

  Timer {
    id: searchDebounce
    interval: root.debounceMs
    repeat: false
    onTriggered: root.refreshRows()
  }

  // ------------------------------------------------------------ definitions
  // Watched, so an edit to either file lands here without a restart -- the
  // same thing Menu.qml does with the same two files.
  FileView {
    id: defaultMenuFile
    path: root.defaultMenuPath
    watchChanges: true
    printErrors: false
    onLoaded: { root.defaultMenuItems = MenuModel.parseMenuJsonc(text()); root.rebuild() }
    onFileChanged: reload()
  }

  FileView {
    id: userMenuFile
    path: root.userMenuPath
    watchChanges: true
    printErrors: false
    onLoaded: { root.userMenuItems = MenuModel.parseMenuJsonc(text()); root.rebuild() }
    onLoadFailed: { root.userMenuItems = []; root.rebuild() }
    onFileChanged: reload()
  }

  // ----------------------------------------------------------------- guards
  // `when:` and `checked:` are bash. Batched into one subprocess per reload,
  // as the menu does, because evaluating them per keystroke would cost about
  // a second and this runs while you type.
  property bool guardsPending: false

  function evaluateGuards() {
    if (guardProc.running) { root.guardsPending = true; return }
    root.guardsPending = false

    var script = MenuModel.guardScript(root.items)
    if (!script) { root.whenResults = ({}); root.checkedResults = ({}); return }
    guardProc.collected = ""
    guardProc.command = ["bash", "-lc", script]
    guardProc.running = true
  }

  Process {
    id: guardProc
    property string collected: ""
    stdout: SplitParser { onRead: function(data) { guardProc.collected += data + "\n" } }
    onExited: function(exitCode, exitStatus) {
      // A killed batch only reported the rows it reached, and an unanswered
      // `when:` shows. Keep the last complete set rather than a partial one.
      if (exitCode !== 0 || exitStatus !== 0) {
        if (root.guardsPending) Qt.callLater(function() { root.evaluateGuards() })
        return
      }
      var nextWhen = ({})
      var nextChecked = ({})
      var lines = guardProc.collected.split("\n")
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim()
        if (!line) continue
        var colon = line.lastIndexOf(":")
        if (colon < 0) continue
        var value = line.substring(colon + 1) === "1"
        var rest = line.substring(0, colon)
        var tagAt = rest.lastIndexOf(":")
        if (tagAt < 0) continue
        var id = rest.substring(0, tagAt)
        var tag = rest.substring(tagAt + 1)
        if (tag === "w") nextWhen[id] = value
        else if (tag === "c") nextChecked[id] = value
      }
      root.whenResults = nextWhen
      root.checkedResults = nextChecked
      root.refreshRows()
      if (root.guardsPending) Qt.callLater(function() { root.evaluateGuards() })
    }
  }
}
