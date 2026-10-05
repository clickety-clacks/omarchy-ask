import QtQuick
import Quickshell
import Quickshell.Io

// One Hub subscriber for the Ask manager. Conversations only receive the
// current complete roster; they do not each open a stream or retain diffs.
Item {
  id: root

  property string host: ""
  property int port: 0
  property string transport: "auto"
  property var agents: []
  property bool connected: false
  property string error: ""
  property int restartDelayMs: 1000
  property string configuredHost: ""
  property int configuredPort: 0
  readonly property string clientPath: Qt.resolvedUrl("bridge/agentd-hub.js").toString().replace(/^file:\/\//, "")

  function send(value) {
    if (!hubProcess.running || !hubProcess.stdinEnabled) return
    hubProcess.write(JSON.stringify(value) + "\n")
  }

  function configure() {
    var nextHost = String(root.host || "")
    var nextPort = Number(root.port || 0)
    var endpointChanged = nextHost !== root.configuredHost || nextPort !== root.configuredPort
    root.configuredHost = nextHost
    root.configuredPort = nextPort
    if (endpointChanged) {
      root.agents = []
      root.restartDelayMs = 1000
    }
    send({ op: "configure", host: nextHost, port: nextPort, transport: String(root.transport || "auto") })
  }

  function activate(id) {
    send({ op: "activate", id: String(id || "") })
  }

  onHostChanged: configure()
  onPortChanged: configure()
  onTransportChanged: configure()

  Timer {
    id: restartTimer
    interval: root.restartDelayMs
    repeat: false
    onTriggered: {
      if (!hubProcess.running) hubProcess.running = true
    }
  }

  Process {
    id: hubProcess
    command: ["node", root.clientPath]
    running: true
    stdinEnabled: true
    stdout: SplitParser {
      onRead: function(line) {
        try {
          var message = JSON.parse(String(line || ""))
          if (message.type === "snapshot") {
            root.agents = Array.isArray(message.agents) ? message.agents : []
            root.connected = true
            root.error = ""
            // A complete valid snapshot proves the child survived long enough
            // to do useful work; only then reset crash backoff.
            root.restartDelayMs = 1000
          } else if (message.type === "status") {
            root.connected = message.connected === true
            root.error = String(message.error || "")
            if (!root.connected) {
              if (root.error === "disabled") root.agents = []
              else root.agents = root.agents.map(function(agent) {
                return Object.assign({}, agent, { hubSourceState: "unreachable" })
              })
            }
          }
        } catch (error) { }
      }
    }
    onRunningChanged: if (running) {
      restartTimer.stop()
      Qt.callLater(root.configure)
    }
    onExited: {
      root.connected = false
      root.error = "hub client stopped"
      // A child crash is not evidence that the roster became empty. Preserve
      // the last complete snapshot, but make every row visibly unreachable
      // until a restarted client receives a fresh valid snapshot.
      root.agents = root.agents.map(function(agent) {
        return Object.assign({}, agent, { hubSourceState: "unreachable" })
      })
      root.restartDelayMs = Math.min(30000, Math.max(1000, root.restartDelayMs * 2))
      restartTimer.restart()
    }
  }

  Component.onCompleted: Qt.callLater(root.configure)
}
