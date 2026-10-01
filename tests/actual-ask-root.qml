import QtQuick
import Quickshell
import Quickshell.Io
import "ask" as AskPlugin

Scope {
  property int unregisteredFocus: 0
  AskPlugin.Ask { id: manager }
  Connections {
    target: manager.conversations.length ? manager.conversations[0] : null
    function onShortcutFocusedChanged() {
      if (target.pinned && target.shortcutFocused && !target.shortcutReady) unregisteredFocus++
    }
  }
  IpcHandler {
    target: "askTest"
    function openPrompt(): void { manager.open("{}") }
    function closePrompts(): void { manager.closeAll() }
    function pinPrompt(): void { if (manager.activeOverlay) manager.activeOverlay.pinConversation() }
    function searchPrompt(): void { if (manager.activeOverlay) manager.activeOverlay.enterSearchMode("files", "") }
    function filesPrompt(): void { if (manager.activeOverlay) manager.activeOverlay.openFileBrowser("files", "ask-shortcut-test-no-match") }
    function permissionPrompt(): void { if (manager.activeOverlay) manager.activeOverlay.enqueuePermission("test-only", "Keyboard test") }
    function state(): string {
      return JSON.stringify({ opened: manager.opened, count: manager.conversations.length,
        runtimeReady: manager.shortcutRuntimeReady, runtimePending: manager.shortcutRuntimePending,
        runtimeError: manager.shortcutRuntimeError,
        pinned: manager.conversations.length ? manager.conversations[0].pinned : false,
        pinPending: manager.conversations.length ? manager.conversations[0].pinPending : false,
        selector: manager.conversations.length ? manager.conversations[0].harnessSelectorOpen : false,
        focused: manager.conversations.length ? manager.conversations[0].shortcutFocused : false,
        ready: manager.conversations.length ? manager.conversations[0].shortcutReady : false,
        bridgePid: manager.conversations.length ? manager.conversations[0].bridgeProcessId : null,
        searchMode: manager.conversations.length ? manager.conversations[0].searchMode : "",
        files: manager.conversations.length ? manager.conversations[0].fileBrowserOpen : false,
        permission: manager.conversations.length ? manager.conversations[0].pendingPermissionId !== "" : false,
        unregisteredFocus: unregisteredFocus })
    }
  }
}
