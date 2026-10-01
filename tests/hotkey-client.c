// Test-only client for Hyprland's vicinae global-hotkey protocol. It records
// counters for two fixed test chords, never application text or user input.
#include <wayland-client.h>
#include <xkbcommon/xkbcommon-keysyms.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include "vicinae-hotkey-v1-client-protocol.h"

struct counts { unsigned bound, denied, revoked, pressed, released; };
static struct vicinae_hotkey_manager_v1 *manager;
static struct counts owned, system_key;

static void bound(void *data, struct vicinae_hotkey_v1 *key) { (void)key; ((struct counts *)data)->bound++; }
static void denied(void *data, struct vicinae_hotkey_v1 *key, uint32_t reason, const char *message) {
    (void)key; (void)reason; (void)message; ((struct counts *)data)->denied++;
}
static void revoked(void *data, struct vicinae_hotkey_v1 *key, uint32_t reason, const char *message) {
    (void)key; (void)reason; (void)message; ((struct counts *)data)->revoked++;
}
static void pressed(void *data, struct vicinae_hotkey_v1 *key, uint32_t serial, uint32_t time) {
    (void)key; (void)serial; (void)time; ((struct counts *)data)->pressed++;
}
static void released(void *data, struct vicinae_hotkey_v1 *key, uint32_t serial, uint32_t time) {
    (void)key; (void)serial; (void)time; ((struct counts *)data)->released++;
}
static const struct vicinae_hotkey_v1_listener hotkey_listener = {bound, denied, revoked, pressed, released};
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)data; (void)version;
    if (!strcmp(interface, "vicinae_hotkey_manager_v1"))
        manager = wl_registry_bind(registry, name, &vicinae_hotkey_manager_v1_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = {global, removed};

static void report(void) {
    printf("{\"bound\":%u,\"denied\":%u,\"revoked\":%u,\"ownedPress\":%u,\"ownedRelease\":%u,\"systemPress\":%u,\"systemRelease\":%u}\n",
        owned.bound + system_key.bound, owned.denied + system_key.denied, owned.revoked + system_key.revoked,
        owned.pressed, owned.released, system_key.pressed, system_key.released);
}

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !manager) return 2;
    struct vicinae_hotkey_v1 *a = vicinae_hotkey_manager_v1_bind(manager, XKB_KEY_comma,
        VICINAE_HOTKEY_MANAGER_V1_MODIFIERS_SUPER, NULL, "ask-shortcut-test", "test owned chord");
    struct vicinae_hotkey_v1 *b = vicinae_hotkey_manager_v1_bind(manager, XKB_KEY_F5,
        0, NULL, "ask-shortcut-test", "test system chord");
    vicinae_hotkey_v1_add_listener(a, &hotkey_listener, &owned);
    vicinae_hotkey_v1_add_listener(b, &hotkey_listener, &system_key);
    if (wl_display_roundtrip(display) < 0) return 3;
    report();
    struct pollfd fds[] = {{wl_display_get_fd(display), POLLIN, 0}, {0, POLLIN, 0}};
    for (;;) {
        if (wl_display_dispatch_pending(display) < 0 || wl_display_flush(display) < 0) break;
        if (poll(fds, 2, -1) < 0) break;
        if (fds[0].revents & (POLLERR | POLLHUP)) break;
        if ((fds[0].revents & POLLIN) && wl_display_dispatch(display) < 0) break;
        if (fds[1].revents & (POLLIN | POLLHUP)) {
            char line[32];
            if (!fgets(line, sizeof line, stdin)) break;
            if (!strcmp(line, "state\n")) {
                if (wl_display_roundtrip(display) < 0) break;
                report();
            } else break;
        }
    }
    vicinae_hotkey_v1_destroy(a);
    vicinae_hotkey_v1_destroy(b);
    vicinae_hotkey_manager_v1_destroy(manager);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return 0;
}
