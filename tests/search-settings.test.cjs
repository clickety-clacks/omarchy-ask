const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { test } = require('node:test');

const repo = resolve(__dirname, '..');

function qmlFixture() {
  const importPath = `file:${repo}`;
  return `
import QtQuick
import Quickshell
import "${importPath}" as AskPlugin

Scope {
  id: root
  property var failures: []
  property var browsed: []
  property var openedPaths: []
  property var openedAgents: []

  AskPlugin.MenuSearch {
    id: search
    debounceMs: 2000
    onBrowseRequested: function(mode, query) {
      root.browsed.push({ mode: mode, query: query })
    }
    onPathActionRequested: function(path, repository, verb) {
      root.openedPaths.push({ path: path, repository: repository, verb: verb })
    }
    onAgentRequested: function(id) { root.openedAgents.push(id) }
  }

  function fail(message) { root.failures.push(message) }
  function check(condition, message) { if (!condition) fail(message) }
  function ids(rows) {
    return rows.map(function(row) { return String(row.id || "") })
  }
  function countBucket(rows, bucket) {
    return rows.filter(function(row) { return row.bucketKey === bucket }).length
  }
  function uniqueRows(rows) {
    var seen = ({})
    for (var index = 0; index < rows.length; index++) {
      var id = String(rows[index].id || "")
      if (seen[id]) return false
      seen[id] = true
    }
    return true
  }
  function names(rows) {
    return rows.map(function(row) { return String(row.label || "") })
  }
  function goItems(count, query) {
    var items = { root: { id: "root", kind: "menu", parent: "", label: "Go" } }
    var order = ["root"]
    for (var index = 0; index < count; index++) {
      var id = "go-" + index
      items[id] = { id: id, kind: "action", label: query + " go " + index,
        parent: "root", action: "true", aliases: [] }
      order.push(id)
    }
    return { items: items, order: order }
  }
  function fileRows(count, query, prefix) {
    var rows = []
    for (var index = 0; index < count; index++)
      rows.push({ name: query + " " + prefix + " " + index,
        relativePath: prefix + "/" + index, path: "/tmp/" + prefix + "-" + index })
    return rows
  }
  function windowRows(count, query) {
    var rows = []
    for (var index = 0; index < count; index++)
      rows.push({ title: query + " window " + index, stableId: String(index + 1),
        workspace: String(index % 2 + 1), class: "test", score: index })
    return rows
  }
  function agents(count, query) {
    var rows = []
    for (var index = 0; index < count; index++)
      rows.push({ name: query + " agent " + index, machine: "host-" + index,
        instanceId: "instance-" + index, id: { pid: index + 10, startTimeTicks: index + 20 },
        activity: { state: "idle" }, presence: { state: "present" } })
    return rows
  }
  function apps(count, query) {
    var rows = []
    for (var index = 0; index < count; index++)
      rows.push({ id: "app-" + index, name: query + " app " + index,
        subtext: "application " + index, icon: "" })
    return rows
  }
  function configureAppLibrary(entries) {
    search.appLibrary = {
      sortedEntries: function(value) {
        var needle = String(value || "").toLowerCase()
        return entries.filter(function(entry) {
          return entry.name.toLowerCase().indexOf(needle) >= 0
        }).map(function(entry) { return { entry: entry } })
      },
      entryName: function(entry) { return entry.name },
      entrySubtext: function(entry) { return entry.subtext },
      iconSource: function() { return "" },
      launch: function() {}
    }
  }
  function configureDesktopEntries(entries) {
    search.desktopEntries = { values: entries }
  }
  function resetRows() {
    search.fileRows = []
    search.fileMatchCount = 0
    search.fileMatchCapped = false
    search.fileMatchComplete = true
    search.repoRows = []
    search.repoMatchCount = 0
    search.repoMatchCapped = false
    search.repoMatchComplete = true
    search.windowRows = []
    search.windowMatchCount = 0
    search.windowMatchCapped = false
    search.windowMatchComplete = true
    search.agentRows = []
    configureAppLibrary([])
    configureDesktopEntries([])
  }
  function runTests() {
    resetRows()
    search.items = ({})
    search.itemOrder = []
    search.query = "needle"
    search.fileRows = fileRows(4, "needle", "file")
    search.fileMatchCount = 4
    search.repoRows = fileRows(3, "needle", "repo")
    search.repoMatchCount = 3
    search.windowRows = windowRows(4, "needle")
    search.windowMatchCount = 4
    search.agentRows = agents(3, "needle")
    configureAppLibrary(apps(3, "needle"))
    var menu = goItems(3, "needle")
    search.items = menu.items
    search.itemOrder = menu.order
    search.refreshRows()
    var summaries = search.rows.filter(function(row) { return row.isAggregate })
    check(search.rows.slice(0, 3).map(function(row) {
      return row.aggregateBucket || row.bucketKey
    }).join(",") === "apps,apps,apps", "Apps summary and its first results lead ordinary search")
    check(summaries.map(function(row) { return row.aggregateBucket }).join(",")
      === "apps,files,repos,windows,agents", "matching summaries preserve app-first order")
    check(search.rows.slice(3, 7).every(function(row) { return row.isAggregate })
      && search.rows.slice(7, 10).every(function(row) { return row.bucketKey === "go" }),
      "Go rows follow the non-app summaries")
    summaries.forEach(function(row, index) {
      var rowIndex = search.rows.indexOf(row)
      check(search.run(rowIndex, 0), "summary row " + index + " activates")
      check(search.lastRunKeepsOpen, "summary row " + index + " keeps Ask open")
    })
    check(root.browsed.map(function(item) { return item.mode }).join(",")
      === "apps,files,repos,windows,agents", "click/keyboard summary route uses one signal")

    resetRows()
    search.query = "balance"
    search.fileRows = fileRows(15, "balance", "file")
    search.fileMatchCount = 15
    search.windowRows = windowRows(15, "balance")
    search.windowMatchCount = 15
    search.refreshRows()
    check(search.rows.length === 22, "balanced fill reaches twenty individual rows")
    check(countBucket(search.rows, "files") === 10
      && countBucket(search.rows, "windows") === 10, "balanced fill rotates underrepresented buckets")
    check(uniqueRows(search.rows), "balanced fill does not duplicate rows")

    resetRows()
    search.items = ({})
    search.itemOrder = []
    search.query = "three"
    search.fileRows = fileRows(7, "three", "file")
    search.fileMatchCount = 7
    search.windowRows = windowRows(7, "three")
    search.windowMatchCount = 7
    search.agentRows = agents(7, "three")
    search.refreshRows()
    check(search.rows.length === 23, "three equal buckets fill twenty individuals")
    var threeCounts = [countBucket(search.rows, "files"), countBucket(search.rows, "windows"),
      countBucket(search.rows, "agents")]
    check(Math.max.apply(null, threeCounts) - Math.min.apply(null, threeCounts) <= 1,
      "three-way ties rotate fairly")
    check(uniqueRows(search.rows), "three-way fill does not duplicate rows")

    resetRows()
    search.query = "uneven"
    search.fileRows = fileRows(10, "uneven", "file")
    search.fileMatchCount = 10
    search.windowRows = windowRows(2, "uneven")
    search.windowMatchCount = 2
    search.agentRows = agents(5, "uneven")
    search.refreshRows()
    check(countBucket(search.rows, "files") === 10
      && countBucket(search.rows, "windows") === 2
      && countBucket(search.rows, "agents") === 5,
      "exhausted buckets stop while uneven buckets retain all matches")

    resetRows()
    search.query = "single"
    search.fileRows = fileRows(25, "single", "file")
    search.fileMatchCount = 25
    search.refreshRows()
    check(search.rows.length === 21 && countBucket(search.rows, "files") === 20,
      "one bucket fills the target without a hidden cap")
    check(uniqueRows(search.rows), "one-bucket fill does not duplicate rows")

    resetRows()
    search.query = "rank"
    search.fileRows = fileRows(4, "rank", "file")
    search.fileMatchCount = 4
    search.windowRows = windowRows(4, "rank")
    search.windowMatchCount = 4
    search.refreshRows()
    var firstRank = ids(search.rows)
    check(search.rows.filter(function(row) { return row.bucketKey === "files" })
      .slice(0, 2).map(function(row) { return row.label }).join(",")
      === "rank file 0,rank file 1", "each bucket seeds stable top-two results")
    search.refreshRows()
    check(JSON.stringify(firstRank) === JSON.stringify(ids(search.rows)),
      "ranking remains stable across refresh")

    resetRows()
    var shortGo = goItems(3, "shortgo")
    search.items = shortGo.items
    search.itemOrder = shortGo.order
    search.query = "shortgo"
    search.fileRows = fileRows(15, "shortgo", "file")
    search.fileMatchCount = 15
    search.windowRows = windowRows(15, "shortgo")
    search.windowMatchCount = 15
    search.refreshRows()
    check(countBucket(search.rows, "go") === 3
      && countBucket(search.rows, "files") + countBucket(search.rows, "windows") === 17,
      "short Go results reduce the balanced bucket fill to the twenty-row target")
    check(uniqueRows(search.rows), "short-Go fill does not duplicate rows")

    resetRows()
    var large = goItems(25, "large")
    search.items = large.items
    search.itemOrder = large.order
    search.query = "large"
    search.fileRows = fileRows(2, "large", "file")
    search.fileMatchCount = 2
    search.windowRows = windowRows(2, "large")
    search.windowMatchCount = 2
    search.refreshRows()
    check(search.rows.length === 31, "Go plus bucket seeds are not capped at twenty")
    check(countBucket(search.rows, "go") === 25, "all Go rows remain visible")

    resetRows()
    search.items = ({})
    search.itemOrder = []
    search.query = "empty"
    search.refreshRows()
    check(search.rows.length === 0, "empty buckets produce no rows")

    search.query = "solo"
    search.fileRows = fileRows(1, "solo", "file")
    search.fileMatchCount = 1
    search.repoRows = fileRows(1, "solo", "repo")
    search.repoMatchCount = 1
    search.windowRows = windowRows(1, "solo")
    search.windowMatchCount = 1
    search.agentRows = agents(1, "solo")
    configureAppLibrary(apps(1, "solo"))
    var soloGo = goItems(1, "solo")
    search.items = soloGo.items
    search.itemOrder = soloGo.order
    search.refreshRows()
    check(search.rows.length === 6 && !search.rows.some(function(row) { return row.isAggregate }),
      "every singleton bucket becomes one direct item, without a summary or duplicate")
    check(search.rows.map(function(row) { return row.bucketKey }).join(",")
      === "apps,files,repos,windows,agents,go", "matching apps lead singleton results")
    check(uniqueRows(search.rows), "singleton promotion does not duplicate items")
    var priorBrowsed = root.browsed.length
    check(search.run(1, 0) && root.openedPaths.length === 1
      && root.openedPaths[0].path === "/tmp/file-0", "singleton file opens directly")
    check(search.run(4, 0) && root.openedAgents.length === 1,
      "singleton agent activates directly")
    check(root.browsed.length === priorBrowsed, "singleton activation does not browse a bucket")
    search.fileRows = fileRows(25, "solo", "file")
    search.fileMatchCount = 25
    search.refreshRows()
    check(search.rows.length === 21 && countBucket(search.rows, "files") === 15,
      "promoted singletons count toward the twenty individual result target")
    check(uniqueRows(search.rows), "mixed singleton and multi-match fill has no duplicates")

    search.fileRows = fileRows(1, "solo", "file")
    search.fileMatchCount = 1
    var restricted = ["@solo", "^solo", "%solo", "&solo"]
    var restrictedBuckets = ["files", "repos", "windows", "agents"]
    for (var single = 0; single < restricted.length; single++) {
      search.query = restricted[single]
      // Query changes clear asynchronous sources; supply the new responses.
      search.fileRows = fileRows(1, "solo", "file")
      search.fileMatchCount = 1
      search.repoRows = fileRows(1, "solo", "repo")
      search.repoMatchCount = 1
      search.windowRows = windowRows(1, "solo")
      search.windowMatchCount = 1
      search.refreshRows()
      check(search.rows.length === 1 && !search.rows[0].isAggregate
        && search.rows[0].bucketKey === restrictedBuckets[single],
        "restricted singleton shows direct item: " + restricted[single])
    }
    search.focusedBucket = "apps"
    search.query = "solo"
    search.refreshRows()
    check(search.rows.length === 1 && search.rows[0].isApp, "focused singleton app is direct")
    search.focusedBucket = ""
    search.query = "@solo"
    search.fileRows = fileRows(1, "solo", "file")
    search.fileMatchCount = 1
    search.fileMatchComplete = false
    search.refreshRows()
    check(search.rows.length === 1 && !search.rows[0].isAggregate,
      "one partial file match remains directly actionable")
    search.fileMatchComplete = true
    search.fileMatchCapped = true
    search.refreshRows()
    check(search.rows.length === 2 && search.rows[0].isAggregate,
      "one capped file match retains its count summary")

    resetRows()
    search.items = ({})
    search.itemOrder = []
    search.query = "caps"
    search.fileRows = fileRows(1, "caps", "file")
    search.fileMatchCount = 100
    search.fileMatchCapped = true
    search.repoRows = fileRows(1, "caps", "repo")
    search.repoMatchCount = 12
    search.repoMatchComplete = false
    search.windowRows = windowRows(1, "caps")
    search.windowMatchCount = 50
    search.windowMatchCapped = true
    search.refreshRows()
    var capLabels = search.rows.filter(function(row) { return row.isAggregate })
      .map(function(row) { return row.label })
    check(capLabels.indexOf("100+ files") >= 0, "capped file count is truthful")
    check(capLabels.indexOf("12 repositories") >= 0, "incomplete repository count has no progress marker")
    check(capLabels.indexOf("50+ windows") >= 0, "capped window count is truthful")

    resetRows()
    search.focusedBucket = "apps"
    search.query = "needle"
    configureAppLibrary(apps(2, "needle"))
    search.refreshRows()
    check(search.rows.length === 3 && search.rows[0].aggregateBucket === "apps",
      "focused Apps summary refreshes on entry")
    search.query = "missing"
    check(search.rows.length === 0, "focused Apps updates while typing")

    resetRows()
    search.items = ({})
    search.itemOrder = []
    search.appLibrary = null
    configureDesktopEntries([
      { id: "Element X.desktop", name: "Element X", subtext: "Element X" },
      { id: "Xournal.desktop", name: "Xournal++", subtext: "Notes" },
      { id: "ATC.desktop", name: "ATC", subtext: "ATC" }
    ])
    search.query = "Element X"
    search.refreshRows()
    check(search.rows.some(function(row) { return row.isApp && row.label === "Element X" }),
      "desktop-entry fallback matches Element X without the shell AppLibrary")
    search.query = "X"
    search.refreshRows()
    check(search.rows.some(function(row) { return row.isApp && row.label === "Element X" }),
      "desktop-entry fallback matches X as a word in Element X")
    search.query = "atc"
    search.refreshRows()
    check(search.rows.some(function(row) { return row.isApp && row.label === "ATC" }),
      "desktop-entry fallback matches ATC case-insensitively")

    search.focusedBucket = "agents"
    search.query = "Runner"
    search.agentRows = [{ name: "Runner", machine: "other", instanceId: "runner",
      id: { pid: 90, startTimeTicks: 900 }, harness: "ignored",
      activity: { state: "idle" }, presence: { state: "present" } },
      { name: "", machine: "box", instanceId: "fallback", id: { pid: 91, startTimeTicks: 901 },
        tmux: { session: "fallback-session" },
        activity: { state: "active" }, presence: { state: "present" } },
      { name: "", machine: "needle-machine", instanceId: "harness", id: { pid: 92, startTimeTicks: 902 },
        harness: "fallback-harness",
        activity: { state: "unknown" }, presence: { state: "unknown" } }]
    search.query = "Runner"
    search.refreshRows()
    check(search.rows.length === 1 && search.rows[0].label === "Runner",
      "explicit agent name matches independently of status and machine")
    check(JSON.stringify(JSON.parse(search.rows[0].agentId))
      === JSON.stringify(["other", "runner", 90, 900]),
      "agent activation ID uses the bridge structured identity")
    search.query = "needle-machine"
    search.refreshRows()
    check(search.rows.length === 0, "agent machine is not a search identity")
    search.query = "fallback-harness"
    search.refreshRows()
    check(search.rows.length === 1 && search.rows[0].label === "fallback-harness",
      "unnamed agent falls back to harness identity")
    search.query = "active"
    search.refreshRows()
    check(search.rows.length === 0, "agent status is not a search identity")

    search.focusedBucket = ""
    search.query = "&Runner"
    search.fileRows = fileRows(3, "Runner", "noise")
    search.refreshRows()
    check(search.rows.length === 1 && search.rows[0].isAgent
      && search.rows[0].label === "Runner", "ampersand restricts results to agents")
    search.query = "&"
    search.runSettledSearch()
    check(search.rows.length === 4 && search.rows.slice(1).every(function(row) { return row.isAgent }),
      "bare ampersand lists the known agents regardless of status")
    search.query = "&active"
    search.refreshRows()
    check(search.rows.length === 0, "ampersand still matches names, not status")

    if (root.failures.length > 0)
      console.log("ASK_SEARCH_TEST_FAIL " + JSON.stringify(root.failures))
    else
      console.log("ASK_SEARCH_TEST_PASS " + JSON.stringify({ browsed: root.browsed.length }))
    Qt.quit()
  }
  Timer { interval: 350; running: true; onTriggered: root.runTests() }
}
`;
}

function runSearchQml() {
  const temp = mkdtempSync(join(tmpdir(), 'omarchy-ask-search-'));
  try {
    symlinkSync('/usr/share/omarchy/shell/Commons', join(temp, 'Commons'));
    symlinkSync('/usr/share/omarchy/shell/Ui', join(temp, 'Ui'));
    const plugin = join(temp, '.config/omarchy/plugins/clickety-clacks.ask');
    mkdirSync(join(temp, '.config/omarchy/plugins'), { recursive: true });
    symlinkSync(repo, plugin, 'dir');
    const fixture = join(temp, 'search.qml');
    writeFileSync(fixture, qmlFixture());
    const result = spawnSync('quickshell', ['-p', fixture], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: join(temp, '.config'),
        QT_QPA_PLATFORM: 'offscreen', QS_DISABLE_FILE_WATCHER: '1', QS_NO_RELOAD_POPUP: '1' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /ASK_SEARCH_TEST_PASS/, output);
    assert.doesNotMatch(output, /ASK_SEARCH_TEST_FAIL/, output);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index++; continue; }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function qmlFunctions(path, names, scope) {
  const source = readFileSync(path, 'utf8');
  const definitions = names.map((name) => `${name}: (${extractFunction(source, name)})`).join(',');
  const functions = new Function('scope', `with (scope) { return {${definitions}}; }`)(scope);
  Object.assign(scope, functions);
  return functions;
}

test('MenuSearch ordering, activation, balance, counts, and agent identity', () => {
  runSearchQml();
});

test('Ask settings merge preserves unknown top-level and nested fields', () => {
  const scope = {
    minFontScale: 0.7, maxFontScale: 2, minSearchDebounceMs: 0,
    maxSearchDebounceMs: 2000, persistedSettings: {}, persistedPermissionMode: 'permission',
    settingsLoaded: false, fontScale: 1, searchDebounceMs: 270,
    keyboardLineImpulse: 335, keyboardDeceleration: 608, fileOpenCommand: [],
    fileEditCommand: [], repoSearchDepth: 6, selectedAgent: '', selectedModel: '',
    selectedReasoningEffort: '', agentdHubHost: '', agentdHubPort: 0, agentdHubTransport: 'auto',
    settingsSaveTimer: { restart() { this.restarts = (this.restarts || 0) + 1; } },
    settingsFile: { setText(value) { this.text = value; } },
  };
  const functions = qmlFunctions(join(repo, 'Ask.qml'),
    ['loadSettings', 'normalizeCommand', 'flushSettings', 'setAgentdHub'], scope);
  const input = {
    permissionMode: 'yolo', fontScale: 1.2, searchDebounceMs: 300,
    keyboardLineImpulse: 400, keyboardDeceleration: 700,
    fileOpenCommand: ['xdg-open'], fileEditCommand: ['editor'], repoSearchDepth: 4,
    agent: 'codex', model: 'xhigh', reasoningEffort: 'high',
    agentdHubHost: 'legacy-host', agentdHubPort: 99,
    unknownTop: { enabled: true },
    agentdHub: { host: 'hub.example', port: 1234, transport: 'et', unknownNested: { keep: ['me'] } },
  };
  functions.loadSettings(JSON.stringify(input));
  functions.setAgentdHub('new.example', 4321);
  functions.flushSettings();
  const output = JSON.parse(scope.settingsFile.text);
  assert.deepEqual(output.unknownTop, input.unknownTop);
  assert.deepEqual(output.agentdHub.unknownNested, input.agentdHub.unknownNested);
  assert.equal(output.agentdHub.host, 'new.example');
  assert.equal(output.agentdHub.port, 4321);
  assert.equal(output.fontScale, 1.2);
  assert.equal(output.agentdHub.transport, 'et', 'hand-set transport is preserved, not rewritten');
  functions.loadSettings(scope.settingsFile.text);
  assert.equal(scope.agentdHubTransport, 'et', 'transport preference is read');
  assert.equal(scope.agentdHubHost, 'new.example', 'endpoint survives reload');
  assert.equal(scope.agentdHubPort, 4321, 'port survives reload');
  assert.deepEqual(scope.persistedSettings.agentdHub.unknownNested,
    input.agentdHub.unknownNested, 'nested unknown field survives reload');

  functions.loadSettings(JSON.stringify({ agentdHub: { host: '', port: 0 },
    agentdHubHost: 'stale-host', agentdHubPort: 4444 }));
  assert.equal(scope.agentdHubHost, '', 'blank nested host overrides stale legacy host');
  assert.equal(scope.agentdHubPort, 0, 'blank nested endpoint can clear its port');
  assert.equal(scope.agentdHubTransport, 'auto', 'missing transport means auto');
});

test('focused bucket search owns Return/Backspace and renders metadata literally', () => {
  const source = readFileSync(join(repo, 'Conversation.qml'), 'utf8');
  assert.match(source, /readonly property bool searchScopeActive[\s\S]*menuSearch\.focusedBucket/);
  assert.match(source, /Key_Backspace && root\.searchScopeActive[\s\S]*root\.clearSearchScope/);
  assert.match(source, /!root\.menuActivate\(event\.modifiers\) && !root\.searchScopeActive\)\s*root\.submit\(\)/);
  assert.match(source, /onClicked:\s*\{ root\.menuIndex = index; root\.menuActivate\(Qt\.NoModifier\) \}/);
  assert.match(source, /textFormat:\s*Text\.PlainText/,
    'untrusted search labels must not be interpreted as rich text');
});

test('agent summary and typed-prefix route share ampersand mode', () => {
  const scope = {
    searchMode: '', menuIndex: 2,
    menuSearch: { focusedBucket: 'apps' },
    prompt: { text: '', length: 6, cursorPosition: 0, forceActiveFocus() {} },
  };
  scope.root = scope;
  const functions = qmlFunctions(join(repo, 'Conversation.qml'),
    ['enterSearchMode', 'clearSearchScope'], scope);
  functions.enterSearchMode('agents', '&Runner');
  assert.equal(scope.searchMode, '&');
  assert.equal(scope.menuSearch.focusedBucket, '');
  assert.equal(scope.prompt.text, 'Runner');
  assert.equal(scope.menuIndex, -1);
  functions.clearSearchScope();
  assert.equal(scope.searchMode, '');
});

test('Settings hub endpoint commits only deliberately and Escape restores', () => {
  const events = [];
  const scope = {
    visible: true, hubCommitted: false,
    hubHost: 'old.example', hubPort: 1234, openingHubHost: 'old.example', openingHubPort: 1234,
    hubHostBox: { input: { text: 'old.example' } },
    hubPortBox: { input: { text: '1234' } },
  };
  scope.root = scope;
  scope.hubChanged = function(host, port) {
    events.push([host, port]); scope.hubHost = host; scope.hubPort = port;
  };
  const source = readFileSync(join(repo, 'Settings.qml'), 'utf8');
  assert.doesNotMatch(source, /onEditingFinished:\s*root\.commitHub\(\)/,
    'focus loss must not persist endpoint edits');
  assert.match(source, /Key_Return\s*\|\|\s*event\.key === Qt\.Key_Enter[\s\S]*root\.commitHub/,
    'Return must commit even when an optional port is blank');
  const functions = qmlFunctions(join(repo, 'Settings.qml'),
    ['normalizedHubPort', 'commitHub', 'cancel'], scope);
  scope.hubHostBox.input.text = 'typed.example';
  scope.hubPortBox.input.text = '5678';
  assert.equal(events.length, 0, 'typing and focus changes do not commit');
  functions.commitHub();
  assert.deepEqual(events.at(-1), ['typed.example', 5678]);
  scope.hubPortBox.input.text = '70000';
  functions.commitHub();
  assert.deepEqual(events.at(-1), ['typed.example', 65535],
    'committed endpoint uses the persisted port bounds');
  assert.equal(scope.openingHubPort, 65535);
  scope.hubPortBox.input.text = '9999';
  functions.cancel();
  assert.equal(events.length, 2, 'Escape after a commit changes nothing further');
  assert.equal(scope.hubPortBox.input.text, '65535', 'Escape restores the committed value');
  assert.equal(scope.visible, false);
});
