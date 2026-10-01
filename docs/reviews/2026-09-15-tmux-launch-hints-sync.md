# Shared tmux launch-hint correction

Source-only sync from the frozen canonical agent-window-resolver handoff:

- `bridge/agent_window_resolver/collector.py`: SHA256 `42db2f45f002467dc0f22428ae17951a4082a89307eb3f5c81849ca791239bc5`.
- Unmodified maintained regression `tests/test_tmux_launch_hints.py`: SHA256 `aeecfd8036a36709942adde883d7c238b1510bed7cae8fce4fea273cea950f4a`.
- Updated the Node adapter's bundle-integrity expectation; no independent parser edits.

Plumbus isolated stage: `/tmp/ask-tmux-hints.LFstyb`. Both hashes verified there before execution.

```sh
PYTHONPATH=bridge python3 -B -m unittest discover -s tests -p test_tmux_launch_hints.py -v
node --test tests/agent-window-resolver.test.mjs tests/bundled-resolver-local.test.mjs tests/resolver-process-cleanup.test.mjs
```

All nine shared parser/matcher regressions and 24 Node adapter/local-process/cleanup tests passed, with no skips. Captured Pimcamp launch forms now qualify as existing-window candidates alongside attach-session forms. Spaced names, socket selectors, quoted commands and flattened mosh shell hints are covered.

This verifies replayed argv and adapter compatibility, not live Pimcamp desktop focus. No desktop windows were opened, no osanwe tests ran, and Ask was not installed or restarted. The installed osanwe collector still has hash `27e9340020ab06a964ce822c3ba492aa08b599a8487164cd9b802e208f6f025f` and is not this source update.
