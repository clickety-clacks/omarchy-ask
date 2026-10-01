const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repo = resolve(__dirname, '..');

// All settings live in one ordinary window: agent choices apply at once, the
// hub address commits on finish and is restored on cancel.
function fixture() {
  return `
import QtQuick
import Quickshell
import "file:${repo}" as AskPlugin

Scope {
  id: root
  property var failures: []
  property var applied: []
  property var hubs: []

  AskPlugin.Settings {
    id: settings
    agent: "codex"; model: "gpt-6-astra"; reasoningEffort: "low"
    hubHost: "old.example"; hubPort: 8788
    onAgentApplied: function(a, m, e) { root.applied.push([a, m, e]); agent = a; model = m; reasoningEffort = e }
    onHubChanged: function(h, p) { root.hubs.push([h, p]); hubHost = h; hubPort = p }
  }

  function check(condition, message) { if (!condition) root.failures.push(message) }

  Timer {
    interval: 300
    running: true
    onTriggered: {
      check(settings.title === "Ask Settings", "window title")
      settings.open()
      check(settings.visible, "opens")
      settings.chooseAgent("claude")
      check(JSON.stringify(root.applied[0]) === JSON.stringify(["claude", "claude-opus-5", "low"]),
        "agent choice applies at once: " + JSON.stringify(root.applied))

      settings.open()
      settings.hubHostInput().text = "new.example"
      settings.cancel()
      check(!settings.visible && root.hubs.length === 0, "escape leaves the hub as it was: " + JSON.stringify(root.hubs))

      settings.open()
      settings.hubHostInput().text = "new.example"
      settings.finish()
      check(!settings.visible && JSON.stringify(root.hubs) === JSON.stringify([["new.example", 8788]]),
        "finish commits the hub: " + JSON.stringify(root.hubs))

      console.log(root.failures.length ? "ASK_SETTINGS_TEST_FAIL " + JSON.stringify(root.failures) : "ASK_SETTINGS_TEST_PASS")
      Qt.quit()
    }
  }
}
`;
}

// The whole plugin still loads with the old panels gone. Its overlay needs a
// real layer-shell compositor, so this runs only on request, inside a
// disposable session (e.g. Scottland's tests/headless.sh run).
function askFixture() {
  return `
import QtQuick
import Quickshell
import "file:${repo}" as AskPlugin

Scope {
  AskPlugin.Ask { id: manager }
  Timer {
    interval: 500
    running: true
    onTriggered: { console.log("ASK_ROOT_LOADED " + (manager !== null)); Qt.quit() }
  }
}
`;
}

function run(source, platform = 'offscreen') {
  const temp = mkdtempSync(join(tmpdir(), 'omarchy-ask-settings-'));
  try {
    symlinkSync('/usr/share/omarchy/shell/Commons', join(temp, 'Commons'));
    symlinkSync('/usr/share/omarchy/shell/Ui', join(temp, 'Ui'));
    const path = join(temp, 'shell.qml');
    writeFileSync(path, source);
    const result = spawnSync('quickshell', ['-p', path], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: join(temp, '.config'),
        QT_QPA_PLATFORM: platform, QS_DISABLE_FILE_WATCHER: '1', QS_NO_RELOAD_POPUP: '1' },
    });
    return `${result.stdout}\n${result.stderr}`;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('one settings window: agent applies at once, hub commits or cancels', () => {
  const output = run(fixture());
  assert.match(output, /ASK_SETTINGS_TEST_PASS/, output);
});

test('the Ask plugin loads with combined settings', { skip: process.env.ASK_WAYLAND_QML_TEST !== '1' }, () => {
  const output = run(askFixture(), 'wayland');
  assert.match(output, /ASK_ROOT_LOADED true/, output);
  assert.doesNotMatch(output, /(MotionTuner|HarnessSelector|Settings)\.qml.*(Error|error|not a type)/, output);
});
