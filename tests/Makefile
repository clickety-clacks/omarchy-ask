# Use the protocol XML from the exact tested Hyprland source tree, e.g.
# make -C tests HYPRLAND_PROTOCOLS=/tmp/hyprland-src/protocols
HYPRLAND_PROTOCOLS ?= /usr/share/hyprland/protocols
CFLAGS += -Wall -Wextra -Werror -O2 $(shell pkg-config --cflags wayland-client xkbcommon)

.PHONY: all
all: .build/hotkey-client .build/keyboard-client

.build/keyboard-client: keyboard-client.c .build/virtual-keyboard-unstable-v1-client-protocol.h .build/virtual-keyboard-unstable-v1-protocol.c
	$(CC) $(CFLAGS) -I.build -o $@ keyboard-client.c .build/virtual-keyboard-unstable-v1-protocol.c $(shell pkg-config --libs wayland-client xkbcommon)

.build/virtual-keyboard-unstable-v1-client-protocol.h: $(HYPRLAND_PROTOCOLS)/virtual-keyboard-unstable-v1.xml
	mkdir -p .build
	wayland-scanner client-header $< $@

.build/virtual-keyboard-unstable-v1-protocol.c: $(HYPRLAND_PROTOCOLS)/virtual-keyboard-unstable-v1.xml
	mkdir -p .build
	wayland-scanner private-code $< $@

.build/hotkey-client: hotkey-client.c .build/vicinae-hotkey-v1-client-protocol.h .build/vicinae-hotkey-v1-protocol.c
	$(CC) $(CFLAGS) -I.build -o $@ hotkey-client.c .build/vicinae-hotkey-v1-protocol.c $(shell pkg-config --libs wayland-client)

.build/vicinae-hotkey-v1-client-protocol.h: $(HYPRLAND_PROTOCOLS)/vicinae-hotkey-v1.xml
	mkdir -p .build
	wayland-scanner client-header $< $@

.build/vicinae-hotkey-v1-protocol.c: $(HYPRLAND_PROTOCOLS)/vicinae-hotkey-v1.xml
	mkdir -p .build
	wayland-scanner private-code $< $@
