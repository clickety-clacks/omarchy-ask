// Test-only virtual keyboard with a complete XKB map and conventional evdev
// keycodes. Unlike wtype's sparse map, this can exercise native code bindings.
#define _GNU_SOURCE
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "virtual-keyboard-unstable-v1-client-protocol.h"

static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *manager;
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)data; (void)version;
    if (!strcmp(interface, "wl_seat")) seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
    if (!strcmp(interface, "zwp_virtual_keyboard_manager_v1"))
        manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = {global, removed};

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    setvbuf(stdout, NULL, _IOLBF, 0);
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return 2;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !seat || !manager) return 3;
    struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_rule_names names = {.rules = "evdev", .model = "pc105", .layout = argv[1]};
    struct xkb_keymap *keymap = xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) return 4;
    struct xkb_state *state = xkb_state_new(keymap);
    char *text = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    size_t length = strlen(text) + 1;
    int fd = memfd_create("ask-keyboard-test", MFD_CLOEXEC);
    if (fd < 0 || write(fd, text, length) != (ssize_t)length) return 5;
    struct zwp_virtual_keyboard_v1 *keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
    zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, length);
    close(fd);
    free(text);
    if (wl_display_roundtrip(display) < 0) return 6;
    puts("ready");
    int pressed[768] = {0};
    char command[64], action[16];
    unsigned code;
    while (fgets(command, sizeof command, stdin)) {
        if (sscanf(command, "%15s %u", action, &code) != 2 || code > 767) break;
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        uint32_t timestamp = (uint32_t)(now.tv_sec * 1000 + now.tv_nsec / 1000000);
        if (!strcmp(action, "press") || !strcmp(action, "release")) {
            int down = !strcmp(action, "press");
            pressed[code] = down;
            zwp_virtual_keyboard_v1_key(keyboard, timestamp, code,
                down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
            xkb_state_update_key(state, code + 8, down ? XKB_KEY_DOWN : XKB_KEY_UP);
        } else if (!strcmp(action, "group")) {
            xkb_state_update_mask(state,
                xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED),
                xkb_state_serialize_mods(state, XKB_STATE_MODS_LATCHED),
                xkb_state_serialize_mods(state, XKB_STATE_MODS_LOCKED), 0, 0, code);
        } else break;
        zwp_virtual_keyboard_v1_modifiers(keyboard,
            xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED),
            xkb_state_serialize_mods(state, XKB_STATE_MODS_LATCHED),
            xkb_state_serialize_mods(state, XKB_STATE_MODS_LOCKED),
            xkb_state_serialize_layout(state, XKB_STATE_LAYOUT_EFFECTIVE));
        if (wl_display_roundtrip(display) < 0) break;
        puts("ok");
    }
    // A failed test may close stdin while a key is held. Release only this
    // client's keys before disconnecting, so neither Qt repeat nor compositor
    // held-key bookkeeping leaks into the next case.
    for (unsigned key = 0; key < 768; ++key)
        if (pressed[key]) zwp_virtual_keyboard_v1_key(keyboard, 0, key, WL_KEYBOARD_KEY_STATE_RELEASED);
    zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
    wl_display_roundtrip(display);
    zwp_virtual_keyboard_v1_destroy(keyboard);
    zwp_virtual_keyboard_manager_v1_destroy(manager);
    wl_seat_destroy(seat);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    xkb_state_unref(state);
    xkb_keymap_unref(keymap);
    xkb_context_unref(context);
    return 0;
}
