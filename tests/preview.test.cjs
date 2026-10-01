const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { hostname } = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('real Conversation previews follow file selection in mixed and focused results', {
  skip: process.env.ASK_PREVIEW_UI_TEST !== '1' && 'requires opt-in Plumbus desktop',
}, () => {
  assert.equal(hostname(), 'plumbus');
  assert.ok(process.env.WAYLAND_DISPLAY);
  const repo = resolve(__dirname, '..');
  const temp = mkdtempSync(join(tmpdir(), 'ask-preview-'));
  try {
    symlinkSync('/usr/share/omarchy/shell/Commons', join(temp, 'Commons'));
    symlinkSync('/usr/share/omarchy/shell/Ui', join(temp, 'Ui'));
    mkdirSync(join(temp, '.config/omarchy/plugins'), { recursive: true });
    symlinkSync(repo, join(temp, '.config/omarchy/plugins/clickety-clacks.ask'));
    const first = join(temp, 'first.txt');
    const second = join(temp, 'second.txt');
    writeFileSync(first, 'FIRST PREVIEW CONTENT');
    writeFileSync(second, 'SECOND PREVIEW CONTENT');
    const fixture = join(temp, 'preview.qml');
    writeFileSync(fixture, `
import QtQuick
import Quickshell
import Quickshell.Io
import "file:${repo}" as AskPlugin
Scope {
  id: root
  property var search: null
  property int step: 0
  property var failures: []
  property string lastCapture: ""
  property int captureCount: 0
  AskPlugin.Conversation { id: conversation }
  function check(value, message) { if (!value) failures.push(message) }
  function descendants(item, seen) {
    if (!item) return []
    seen = seen || []
    if (seen.indexOf(item) >= 0) return []
    seen.push(item)
    var result = []
    var groups = [item.children || [], item.data || [], item.contentItem ? [item.contentItem] : []]
    for (var g = 0; g < groups.length; g++) {
      for (var i = 0; i < groups[g].length; i++) {
        var child = groups[g][i]
        result.push(child)
        result = result.concat(descendants(child, seen))
      }
    }
    return result
  }
  function file(path) { return { isPath: true, absolutePath: path, label: path, path: path } }
  function expectPreview(path, text) {
    check(conversation.selectedFilePreviewPath === path, 'selected path: ' + path)
    check(conversation.filePreviewVisible, 'preview visible: ' + path)
    check(conversation.filePreviewText === text, 'actual gjs preview content: ' + path)
    var objects = descendants(conversation)
    var popup = null
    for (var i = 0; i < objects.length; i++)
      if (objects[i].wedgeCenterY !== undefined && objects[i].bodyX !== undefined) popup = objects[i]
    check(popup !== null && popup.visible && popup.width > 0 && popup.height > 0,
      'actual popup item is visible with positive geometry')
    if (popup) {
      check(popup.x >= 0 && popup.x + popup.width <= popup.parent.width
        && popup.y >= 0 && popup.y + popup.height <= popup.parent.height,
        'popup fits its actual window: ' + JSON.stringify({x:popup.x,y:popup.y,
          width:popup.width,height:popup.height,parentWidth:popup.parent.width,parentHeight:popup.parent.height}))
    }
  }
  function advance() {
    if (step === 0) {
      var objects = descendants(conversation)
      for (var i = 0; i < objects.length; i++)
        if (typeof objects[i].refreshRows === 'function') search = objects[i]
      if (!search) { console.log('ASK_PREVIEW_FAIL missing MenuSearch'); Qt.quit(); return }
      // Protocol streaming has its own production integration gate. This
      // fixture injects deterministic rows while retaining the real preview
      // process, so stop only competing search/math/window source processes.
      for (var p = 0; p < objects.length; p++) {
        if (objects[p].command === undefined || objects[p].running === undefined) continue
        var command = String(objects[p].command)
        if (command.indexOf('/bridge/files.js') >= 0 || command.indexOf('/bridge/windows.js') >= 0
            || command.indexOf('/bridge/math.js') >= 0) objects[p].running = false
      }
      search.debounceMs = 1000000
      search.query = 'preview-fixture'
      conversation.open('{}')
      search.rows = [file(${JSON.stringify(first)}), file(${JSON.stringify(second)})]
      conversation.menuIndex = 0
      check(conversation.searchMode === '', 'normal search, no prefix')
    } else if (step === 1) {
      expectPreview(${JSON.stringify(first)}, 'FIRST PREVIEW CONTENT')
      search.rows = [file(${JSON.stringify(second)}), file(${JSON.stringify(first)})]
      check(conversation.menuIndex === 1, 'selected file follows identity after reorder')
    } else if (step === 2) {
      // Selection follows the retained path identity, so after the reorder
      // the selected row is still the first file rather than the new index 1.
      expectPreview(${JSON.stringify(first)}, 'FIRST PREVIEW CONTENT')
      search.rows = [file(${JSON.stringify(second)})]
      check(conversation.menuIndex === -1, 'removed file clears selection')
      check(!conversation.filePreviewVisible, 'removed file clears preview immediately')
      conversation.menuIndex = 0
      conversation.searchMode = '@'
      search.rows = [file(${JSON.stringify(first)})]
      conversation.menuIndex = 0
    } else if (step === 3) {
      expectPreview(${JSON.stringify(first)}, 'FIRST PREVIEW CONTENT')
      search.rows = [{ isAgent: true, label: 'agent' }]
      check(conversation.selectedFilePreviewPath === '', 'agent has no file preview')
      check(!conversation.filePreviewVisible, 'agent clears preview')
      search.rows = [{ isPath: true, isRepository: true, absolutePath: ${JSON.stringify(temp)} }]
      check(conversation.selectedFilePreviewPath === '', 'repository has no file preview')
      conversation.fileBrowserOpen = true
      search.fileRows = [{path: ${JSON.stringify(second)}, name: 'second.txt'}]
      conversation.fileBrowserIndex = 0
    } else if (step === 4) {
      expectPreview(${JSON.stringify(second)}, 'SECOND PREVIEW CONTENT')
      conversation.cancelFilePreview(${JSON.stringify(second)})
      check(conversation.filePreviewVisible, 'pointer exit retains selected preview')
      conversation.fileBrowserOpen = false
      conversation.clearSearchScope()
      var objects = descendants(conversation)
      var composer = null
      for (var i = 0; i < objects.length; i++)
        if (objects[i].shrinkProgress !== undefined) composer = objects[i]
      check(composer !== null, 'found real composer')
      if (composer) {
        search.query = Qt.binding(function() { return conversation.searchMode + composer.text })
        composer.text = '&Runner'
        check(conversation.searchMode === '&' && composer.text === 'Runner',
          'typing ampersand enters agent mode and consumes prefix')
        search.agentRows = [{name: 'Runner', machine: 'fixture', instanceId: 'runner',
          id: {pid: 99, startTimeTicks: '1'}, activity: {state: 'idle'}}]
        search.refreshRows()
        check(search.rows.length === 1 && search.rows[0].isAgent,
          'real composer query filters to agents')
        check(!conversation.filePreviewVisible, 'agent mode does not retain file preview')
        check(conversation.searchScopeActive, 'agent mode owns normal search shortcuts')
        conversation.clearSearchScope()
        check(!conversation.searchScopeActive, 'search mode can be exited')
      }
      conversation.close()
      check(!conversation.filePreviewVisible, 'closing clears preview')
      console.log(failures.length ? 'ASK_PREVIEW_FAIL ' + JSON.stringify(failures) : 'ASK_PREVIEW_PASS')
      Qt.quit()
    }
    step++
  }
  Timer { interval: 900; running: true; repeat: true; onTriggered: root.advance() }
  Process { id: capture }
  Timer {
    interval: 150; running: true; repeat: true
    onTriggered: {
      var directory = Quickshell.env('ASK_PREVIEW_CAPTURE_DIR')
      if (!directory || !conversation.filePreviewVisible || capture.running
          || root.lastCapture === conversation.selectedFilePreviewPath) return
      root.lastCapture = conversation.selectedFilePreviewPath
      capture.command = ['grim', directory + '/preview-' + root.captureCount++ + '.png']
      capture.running = true
    }
  }
}
`);
    const result = spawnSync('quickshell', ['-p', fixture], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: join(temp, '.config'),
        XDG_CACHE_HOME: join(temp, '.cache'), ASK_FILE_ROOT: temp,
        ASK_BRIDGE_COMMAND: JSON.stringify(['python3', join(repo, 'tests/shortcut-fake-bridge.py')]),
        QT_QPA_PLATFORM: 'wayland', QS_DISABLE_FILE_WATCHER: '1',
        QS_NO_RELOAD_POPUP: '1', ASK_SHORTCUT_MODULE_DISABLE: '1' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /ASK_PREVIEW_PASS/, output);
    assert.doesNotMatch(output, /ASK_PREVIEW_FAIL|ReferenceError|TypeError/, output);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
