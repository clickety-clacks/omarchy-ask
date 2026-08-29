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

  signal actionRan(string label)

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

    var scored = []
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
        scored.push({
          id: "app:" + app.id,
          label: name,
          path: root.appLibrary.entrySubtext(app) || "Apps",
          icon: "",
          iconFont: "",
          isApp: true,
          appIcon: app.icon || "",
          appId: String(app.id || ""),
          action: "",
          route: "",
          // sortedEntries is already ranked; keep that order just under an
          // exact menu-row match rather than inventing a competing score.
          score: 1000 - a
        })
      }
    }

    scored.sort(function(a, b) { return b.score - a.score })
    root.rows = scored.slice(0, root.maxRows)
  }

  function run(index) {
    if (index < 0 || index >= root.rows.length) return false
    var row = root.rows[index]
    if (row.isApp) {
      if (!root.appLibrary) return false
      root.appLibrary.launch(row.appId, row.label)
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
      root.rows = []
      return
    }
    searchDebounce.restart()
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
