const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repo = resolve(__dirname, '..');

function fixture() {
  return `
import QtQuick
import Quickshell
import "file:${repo}" as AskPlugin

Scope {
  id: root
  property var failures: []

  AskPlugin.MenuSearch {
    id: search
    debounceMs: 60000
  }

  function check(condition, message) {
    if (!condition) root.failures.push(message)
  }

  function appLabels() {
    return search.rows.filter(function(row) { return row.isApp })
      .map(function(row) { return String(row.label || "") })
  }

  Timer {
    interval: 300
    running: true
    onTriggered: {
      search.items = ({})
      search.itemOrder = []
      search.appLibrary = null
      search.desktopEntries = { values: [
        { id: "Element X.desktop", name: "Element X", subtext: "Element X" },
        { id: "Xournal.desktop", name: "Xournal++", subtext: "Notes" },
        { id: "ATC.desktop", name: "ATC", subtext: "ATC" }
      ] }

      search.query = "Element X"
      search.refreshRows()
      check(search.rows.length > 0 && search.rows[0].label === "Element X",
        "exact desktop-entry match is first")

      search.query = "X"
      search.refreshRows()
      check(appLabels().indexOf("Element X") >= 0,
        "word search matches Element X")
      check(search.rows.length > 0 && search.rows[0].isApp,
        "application results lead mixed search")

      search.query = "atc"
      search.refreshRows()
      check(search.rows.length > 0 && search.rows[0].label === "ATC",
        "case-insensitive desktop-entry match is first")

      if (root.failures.length > 0)
        console.log("ASK_APP_SEARCH_TEST_FAIL " + JSON.stringify(root.failures))
      else
        console.log("ASK_APP_SEARCH_TEST_PASS")
      Qt.quit()
    }
  }
}
`;
}

test('desktop-entry fallback restores app search on scoped Omarchy plugins', () => {
  const temp = mkdtempSync(join(tmpdir(), 'omarchy-ask-app-search-'));
  try {
    symlinkSync('/usr/share/omarchy/shell/Commons', join(temp, 'Commons'));
    symlinkSync('/usr/share/omarchy/shell/Ui', join(temp, 'Ui'));
    const path = join(temp, 'app-search.qml');
    writeFileSync(path, fixture());
    const result = spawnSync('quickshell', ['-p', path], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: join(temp, '.config'),
        QT_QPA_PLATFORM: 'offscreen', QS_DISABLE_FILE_WATCHER: '1', QS_NO_RELOAD_POPUP: '1' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /ASK_APP_SEARCH_TEST_PASS/, output);
    assert.doesNotMatch(output, /ASK_APP_SEARCH_TEST_FAIL/, output);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
