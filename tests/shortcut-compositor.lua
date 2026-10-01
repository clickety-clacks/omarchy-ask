-- Disposable nested compositor only. Never source from a user's desktop config.
hl.monitor({ output = "", mode = "1280x720@60", position = "auto", scale = 1 })
-- wtype provides its own sparse keymap, not physical PC keycodes. Resolve that
-- map for native keybind dispatch; without this, GUI delivery alone is a false
-- positive. This setting belongs ONLY to this synthetic-input test compositor.
hl.config({
  input = { resolve_binds_by_sym = true },
  misc = { disable_hyprland_logo = true, disable_splash_rendering = true }
})
ask_test_counts = { system = 0, conflict = 0, release = 0 }
hl.bind("SUPER + F12", function() ask_test_counts.system = ask_test_counts.system + 1 end)
hl.bind("SUPER + comma", function() ask_test_counts.conflict = ask_test_counts.conflict + 1 end)
hl.bind("CTRL + RETURN", function() ask_test_counts.conflict = ask_test_counts.conflict + 1 end)
hl.bind("F5", function() ask_test_counts.system = ask_test_counts.system + 1 end)
hl.bind("F5", function() ask_test_counts.release = ask_test_counts.release + 1 end, { release = true })
