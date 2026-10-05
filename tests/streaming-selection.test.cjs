const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { hostname, tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

test('real Conversation retains selection identity as streaming buckets reorder', {
  skip: process.env.ASK_PREVIEW_UI_TEST !== '1' && 'requires reserved Testbed desktop',
}, () => {
  assert.equal(hostname(), 'testbed');
  const repo = resolve(__dirname, '..');
  const root = mkdtempSync(join(tmpdir(), 'ask-streaming-selection-'));
  try {
    for (const name of ['Commons', 'Ui']) symlinkSync('/usr/share/omarchy/shell/' + name, join(root, name));
    mkdirSync(join(root, '.config/omarchy/plugins'), { recursive: true });
    symlinkSync(repo, join(root, '.config/omarchy/plugins/clickety-clacks.ask'));
    const selected = join(root, 'needle-original.txt');
    const arriving = join(root, 'needle-arriving.txt');
    writeFileSync(selected, 'SELECTED ORIGINAL');
    writeFileSync(arriving, 'NEW ARRIVAL');
    const fixture = join(root, 'selection.qml');
    writeFileSync(fixture, `
import QtQuick
import Quickshell
import "file:${repo}" as AskPlugin
Scope {
  id: root
  property var search: null
  property var failures: []
  property int step: 0
  property string requestedAgent: ""
  AskPlugin.Conversation {
    id: conversation
    onAgentRequested: function(id) { root.requestedAgent = id }
  }
  function check(ok, message) { if (!ok) failures.push(message) }
  function descendants(item, seen) {
    if (!item || seen.indexOf(item) >= 0) return []
    seen.push(item)
    var result = []
    var groups = [item.children || [], item.data || [], item.contentItem ? [item.contentItem] : []]
    for (var g = 0; g < groups.length; g++) for (var i = 0; i < groups[g].length; i++) {
      var child = groups[g][i]
      result.push(child)
      result = result.concat(descendants(child, seen))
    }
    return result
  }
  function file(path) { return {path: path, name: path.split('/').pop()} }
  function deliver(rows, complete) {
    search.acceptFiles(JSON.stringify({id: search.fileRequestId, query: search.query,
      rows: rows, totalMatched: rows.length, capped: false, complete: complete}))
  }
  function currentPath() {
    var row = search.rows[conversation.menuIndex]
    return row ? String(row.absolutePath || '') : ''
  }
  function advance() {
    if (step === 0) {
      var all = descendants(conversation, [])
      for (var i = 0; i < all.length; i++)
        if (typeof all[i].acceptFiles === 'function') search = all[i]
      if (!search) { console.log('STREAM_SELECTION_FAIL missing search'); Qt.quit(); return }
      conversation.open('{}')
      // This gate supplies protocol snapshots; source IO has its own real-fd
      // integration gate. Stop competing source replies, not UI/preview code.
      for (var p = 0; p < all.length; p++) {
        if (all[p].command === undefined || all[p].running === undefined) continue
        var command = String(all[p].command)
        if (command.indexOf('/bridge/files.js') >= 0 || command.indexOf('/bridge/windows.js') >= 0
            || command.indexOf('/bridge/math.js') >= 0) all[p].running = false
      }
      search.debounceMs = 1000000
      search.query = 'needle'
      search.items = ({})
      search.itemOrder = []
      search.appLibrary = null
      search.agentRows = []
      search.windowRows = []
      deliver([file(${JSON.stringify(selected)})], false)
      check(search.rows.length === 1 && !search.rows[0].isAggregate, 'incomplete singleton is a direct item')
      conversation.menuIndex = 0
    } else if (step === 1) {
      check(conversation.filePreviewText === 'SELECTED ORIGINAL', 'initial preview loaded')
      deliver([file(${JSON.stringify(arriving)}), file(${JSON.stringify(selected)})], false)
      check(currentPath() === ${JSON.stringify(selected)}, 'bucket insertion/reordering preserves selected file')
      check(conversation.selectedFilePreviewPath === ${JSON.stringify(selected)}, 'preview remains on original path')
    } else if (step === 2) {
      check(conversation.filePreviewText === 'SELECTED ORIGINAL', 'late result did not replace preview content')
      deliver([file(${JSON.stringify(selected)})], true)
      check(conversation.menuIndex === 0 && currentPath() === ${JSON.stringify(selected)},
        'return to singleton keeps original selected')
      deliver([file(${JSON.stringify(arriving)})], true)
      check(conversation.menuIndex === -1 && conversation.selectedFilePreviewPath === '',
        'removed target clears selection rather than retargeting Return')
      var agentA = {name:'needle Z',machine:'fixture',instanceId:'a',id:{pid:101,startTimeTicks:'1'}}
      var agentB = {name:'needle A',machine:'fixture',instanceId:'b',id:{pid:102,startTimeTicks:'2'}}
      search.agentRows = [agentA]
      search.refreshRows()
      conversation.menuIndex = search.rows.findIndex(function(row) { return row.isAgent })
      var selectedAgentId = search.rows[conversation.menuIndex].id
      search.agentRows = [agentB, agentA]
      search.refreshRows()
      check(search.rows[conversation.menuIndex]?.id === selectedAgentId,
        'production roster rebuild preserves agent identity')
      var intendedAgent = search.rows[conversation.menuIndex]?.agentId
      check(search.run(conversation.menuIndex, Qt.NoModifier) && requestedAgent === intendedAgent,
        'activation dispatches the same selected agent after reordered results')
      var windowB = {title:'needle window B',stableId:'b',workspace:'1',class:'fixture',score:1}
      var windowA = {title:'needle window A',stableId:'a',workspace:'1',class:'fixture',score:0}
      search.acceptWindows(JSON.stringify({id:search.windowRequestId,rows:[windowB],totalMatched:1,complete:true}))
      conversation.menuIndex = search.rows.findIndex(function(row) { return row.isWindow })
      search.acceptWindows(JSON.stringify({id:search.windowRequestId,rows:[windowA,windowB],totalMatched:2,complete:true}))
      check(search.rows[conversation.menuIndex]?.stableId === 'b',
        'production window protocol rebuild preserves window identity')
      search.query = 'new-query'
      check(conversation.menuIndex === -1, 'new query clears selection')
      conversation.fileBrowserOpen = true
      conversation.fileBrowserMode = 'files'
      search.fileRows = [file(${JSON.stringify(selected)}), file(${JSON.stringify(arriving)})]
      conversation.fileBrowserIndex = 0
      search.fileRows = [file(${JSON.stringify(arriving)}), file(${JSON.stringify(selected)})]
      check(conversation.fileBrowserRows[conversation.fileBrowserIndex]?.path === ${JSON.stringify(selected)},
        'focused browser selection follows path')
    } else if (step === 3) {
      check(conversation.filePreviewText === 'SELECTED ORIGINAL', 'focused browser preview remains original')
      search.fileRows = [file(${JSON.stringify(arriving)})]
      check(conversation.fileBrowserIndex === -1 && conversation.selectedFilePreviewPath === '',
        'focused browser removal clears selection')
      search.fileMatchComplete = true
      search.fileRows = []
      search.fileRows = []
      search.fileRows = [file(${JSON.stringify(arriving)}), file(${JSON.stringify(selected)})]
      check(conversation.fileBrowserIndex === -1 && conversation.selectedFilePreviewPath === '',
        'later snapshot does not resurrect a removed selection onto another item')
      conversation.close()
      console.log(failures.length ? 'STREAM_SELECTION_FAIL ' + JSON.stringify(failures) : 'STREAM_SELECTION_PASS')
      Qt.quit()
    }
    step++
  }
  Timer { interval: 900; running: true; repeat: true; onTriggered: root.advance() }
}
`);
    const result = spawnSync('quickshell', ['-p', fixture], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, '.config'),
        XDG_CACHE_HOME: join(root, '.cache'), ASK_FILE_ROOT: root,
        ASK_BRIDGE_COMMAND: JSON.stringify(['python3', join(repo, 'tests/shortcut-fake-bridge.py')]),
        QT_QPA_PLATFORM: 'wayland', QS_DISABLE_FILE_WATCHER: '1', QS_NO_RELOAD_POPUP: '1',
        ASK_SHORTCUT_MODULE_DISABLE: '1' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /STREAM_SELECTION_PASS/, output);
    assert.doesNotMatch(output, /STREAM_SELECTION_FAIL|ReferenceError|TypeError/, output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
