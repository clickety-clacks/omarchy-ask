# Omarchy Ask

An AI-enabled launcher for Omarchy.

![Omarchy Ask with "who watches the watchers" typed and the agent thinking](assets/omarchy-ask-prompt.png)

![Omarchy Ask: a short exchange, then "george, tell me about the rabbits" answered in character](assets/omarchy-ask.png)

![Typing "app" in the Ask prompt, with menu rows and installed applications listed beneath it](assets/omarchy-ask-menu-search.png)

- **One box, two jobs.** Type a question for Claude Code or Codex over ACP, or type a menu row and run it.
- **Your menu, live.** Ask reads the same definitions the `SUPER+SPACE` menu does, so anything you add there shows up here the moment you save it.
- **Launches apps too.** Same entries, icons and ranking as the app launcher, in one flat list.
- **Return means what you meant.** Type and hit Return to ask; arrow onto a match first and Return runs it instead.
- **Zero residue.** Conversations exist only while the overlay is open.
- **Pin it.** `Ctrl+P` turns a live conversation into a normal window.
- **Your size.** `Ctrl` `+` / `-` resizes everything, and remembers.

## Requirements

- Omarchy Quattro 4.0.0 or newer with the Quickshell-based Omarchy Shell
- Node.js and npm
- A working Claude Code or Codex login

Omarchy Ask is not compatible with Omarchy 3 and its Waybar-based desktop. It
is currently verified on Omarchy `4.0.0-1`; later Quattro releases are intended
to remain compatible through the public shell-plugin contract.

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

## Remove

Remove the plugin and delete the `Ask` binding you added to
`~/.config/hypr/bindings.lua`:

```sh
omarchy plugin remove clickety-clacks.ask
hyprctl reload
```

Ask leaves its small preferences file in place so reinstalling preserves your
settings. Remove it too if you want to clear all Ask state:

```sh
rm ~/.config/omarchy/ask.json
```

## Agent and working directory

Claude is the default. Set `ASK_AGENT=codex` in the Omarchy Shell environment to use Codex ACP. Set `ASK_CWD` to choose the agent's working directory; otherwise Ask uses `$HOME`.

Each conversation starts its own ACP bridge and session and reuses them for
every turn. Pinning retains that exact process and session in a normal window;
opening Ask again creates an independent conversation.

## Controls

- `Return`: submit
- `Shift+Return`: insert a newline
- `Ctrl+W`: delete the word before the caret; `Ctrl+E`: jump to the end of the prompt
- `Escape`: close and discard the session (overlay only — a pinned window closes
  like any other window, through your window manager)
- `Arrow keys` or `Ctrl+H/J/K/L`: scroll the conversation
- `PageUp/PageDown` or `Ctrl+U/D`: scroll by page
- `Ctrl+=` / `Ctrl+-`: grow or shrink the conversation text
- `Ctrl+0`: return the conversation text to its default size
- Mouse selection and `Ctrl+C`: copy conversation text
- `Ctrl+V`: paste into the prompt
- `Y` / `N`: allow or deny a pending tool request
- `Ctrl+P` or the pin icon: move the live conversation into a normal resizable
  window

Pinned conversations remain open with their own agent sessions. Invoking the
Ask shortcut again opens a fresh overlay instead of dismissing pinned windows.

Text size applies to every conversation, in the overlay and in pinned windows
alike, and is remembered across restarts.

The text control in the upper-right is persistent. **Ask** requests permission
before tools run; **YOLO** automatically selects the ACP agent's one-time allow
option. Ask is the default until you explicitly select YOLO. The selection is
stored in `~/.config/omarchy/ask.json` and is shared by new conversations.

YOLO is intentionally conspicuous because it permits agent tools to run
without another click. It does not grant capabilities the underlying agent
lacks, alter its sandbox, or manufacture an allow option when the ACP agent
does not offer one.

## Conversation behavior

- The `▪` marker identifies the input line; it is not sent to the agent.
- ACP `messageId` boundaries become separate assistant paragraphs.
- Paragraph breaks inside an assistant reply are rendered with a blank line
  between them. Fenced code and list structure are left as the agent wrote them.
- Submitting glides the new prompt to the top of the viewport and lets the
  reply fill the space beneath it. A prompt submitted while you are scrolled up
  in the history never moves the viewport.
- Assistant growth follows the bottom only if the viewport was already there.
- Closing an overlay or pinned window ends only that conversation and its ACP
  process.
- The global shortcut toggles the active overlay. Pinned windows are never
  dismissed by that shortcut.
- Markdown links open through the desktop's external URL handler.

## Your menu is already in it

Ask keeps no list of its own — it reads the menu's own definitions, including
the `when:` conditions that decide what applies right now. Install a plugin
that adds a menu row and the row is in Ask too, without either of them knowing
about the other.

- `Down`/`Up` or `Tab`/`Shift+Tab`: move through matches
- `Return`: run the selected row, or submit a prompt when nothing is selected
- `Escape`: drop the selection (the overlay's own `Escape` still closes it)

Choosing a submenu opens it in the real menu; choosing an application launches
it. Either way the overlay gets out of the way.

Matching waits for a pause in typing so the card resizes once rather than on
every keystroke. Tune that with `searchDebounceMs` in
`~/.config/omarchy/ask.json` — milliseconds, `270` by default, `0` to match
immediately. The file is watched, so an edit applies without a restart.

## Local state

Ask keeps no transcript archive. Conversation text and ACP session state live
only in their conversation process and disappear when its window is closed. The
durable application state is the Ask/YOLO choice and the conversation text
size, both held in:

```text
~/.config/omarchy/ask.json
```

The coding-agent CLIs may maintain their own logs or session data according to
their own configuration; Omarchy Ask does not manage or erase that data.

## Troubleshooting

### The overlay does not start

Install the bridge dependencies and confirm the chosen agent is authenticated:

```sh
cd ~/.config/omarchy/plugins/clickety-clacks.ask/bridge
npm ci
claude --version                    # default agent
# or: codex --version               # when ASK_AGENT=codex
```

### Changes or a new version do not appear

Update the git-managed plugin, reinstall dependencies if the lockfile changed,
and restart the long-lived shell process:

```sh
omarchy plugin update clickety-clacks.ask --yes
cd ~/.config/omarchy/plugins/clickety-clacks.ask/bridge && npm ci
omarchy restart shell
```

### A tool appears stuck

In Ask mode, look for the centered permission dialog and answer with its
buttons or `Y` / `N`. In YOLO mode, verify the upper-right label says `YOLO`.
If the bridge exits, close that conversation and open a new one; the status
line reports that the ACP session ended.

### The shortcut needs two presses after pinning

Upgrade to `0.2.0` or newer. The plugin manager exposes the active overlay's
real `opened` state so Omarchy Shell does not confuse a retained pinned window
with an open overlay.

## Development

Validate the plugin manifest with:

```sh
omarchy plugin validate .
```

Changes inside an installed user plugin are detected by Omarchy Shell. If a stale QML instance remains after an error, run `omarchy restart shell`.

The validator rejects symlinks by design. Validate a clean plugin tree rather
than the installed `bridge/node_modules` directory, whose `.bin` entries are
symlinks. See [CONTRIBUTING.md](CONTRIBUTING.md) for the exact command.

Maintainers should also read:

- [Architecture and invariants](docs/architecture.md)
- [Regression testing](docs/testing.md)

## License

MIT
