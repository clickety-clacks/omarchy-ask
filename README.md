# Omarchy Ask

A focused, ephemeral conversation overlay for [Omarchy](https://omarchy.org/). Open it with a global shortcut, type a request, and talk to Claude Code or Codex through the Agent Client Protocol (ACP). Closing the overlay discards the conversation.

![Omarchy Ask showing a conversation with an agent](assets/omarchy-ask.png)

The interface uses large serif typography for the prompt, smaller Markdown-rendered assistant responses, selectable conversation text, animated growth as replies arrive, streaming output, tool-status updates, and interactive ACP permission requests. Prompt type scales down as it gains visual lines.

## Requirements

- Omarchy with the Quickshell-based Omarchy Shell
- Node.js and npm
- A working Claude Code or Codex login

## Install

```sh
omarchy plugin add https://github.com/clickety-clacks/omarchy-ask.git --enable --yes
cd ~/.config/omarchy/plugins/clickety-clacks.ask/bridge
npm ci
```

Add a Hyprland binding to `~/.config/hypr/bindings.lua`:

```lua
o.bind("CTRL + SHIFT + SPACE", "Ask", "omarchy-shell shell toggle clickety-clacks.ask '{}'")
```

Then reload Hyprland:

```sh
hyprctl reload
```

## Agent and working directory

Claude is the default. Set `ASK_AGENT=codex` in the Omarchy Shell environment to use Codex ACP. Set `ASK_CWD` to choose the agent's working directory; otherwise Ask uses `$HOME`.

The bridge starts one ACP session when the overlay opens and reuses it for every turn, preserving conversation continuity and tool-call state until the overlay closes.

## Controls

- `Return`: submit
- `Shift+Return`: insert a newline
- `Escape`: close and discard the session
- `Arrow keys` or `Ctrl+H/J/K/L`: scroll the conversation
- `PageUp/PageDown` or `Ctrl+U/D`: scroll by page
- Mouse selection and `Ctrl+C`: copy conversation text
- `Ctrl+V`: paste into the prompt
- `Y` / `N`: allow or deny a pending tool request

The mode switch at the top of the overlay is persistent. **Permission** asks
before tools run; **YOLO** automatically accepts tool requests. Permission is
the default until you explicitly select YOLO.

## Development

Validate the plugin manifest with:

```sh
omarchy plugin validate .
```

Changes inside an installed user plugin are detected by Omarchy Shell. If a stale QML instance remains after an error, run `omarchy restart shell`.

## License

MIT
