// Experimental compositor-side routing. No keybinding objects are changed.
// Build against the EXACT running Hyprland ABI; test on a disposable desktop.
#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/managers/KeybindManager.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/managers/SessionLockManager.hpp>
#include <hyprland/src/managers/EventManager.hpp>
#include <hyprland/src/desktop/view/WLSurface.hpp>
#include <hyprland/src/desktop/view/LayerSurface.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/view/Popup.hpp>
#include <hyprland/src/desktop/state/ViewState.hpp>
#include <hyprland/src/devices/IKeyboard.hpp>
#include <hyprland/src/protocols/Hotkey.hpp>
#include <hyprland/src/protocols/LayerShell.hpp>

#include <map>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <tuple>
#include <limits>
#include <set>

#ifndef ASK_SCOPE_BUILD_ID
#define ASK_SCOPE_BUILD_ID "development"
#endif

namespace {
using View = Desktop::View::IView;
using Surface = Desktop::View::CWLSurface;
using Original = SDispatchResult (*)(CKeybindManager*, uint32_t,
    const SPressedKeyWithMods&, bool, SP<IKeyboard>, SP<IHID>);
CFunctionHook* hook = nullptr;
CFunctionHook* hotkeyHook = nullptr;
CFunctionHook* keyEventHook = nullptr;
thread_local IKeyboard* dispatchKeyboard = nullptr;
HANDLE pluginHandle = nullptr;
SP<SHyprCtlCommand> command;

struct Chord {
    uint32_t mods;
    xkb_keysym_t sym;
};
struct Scope {
    WP<View> owner;
    std::vector<Chord> chords;
};
std::vector<Scope> scopes;
// Release belongs to the recipient of the press, even if focus changes in
// between. Native key bookkeeping remains in CKeybindManager::onKeyEvent.
std::map<std::pair<const void*, uint32_t>, bool> presses;
std::set<std::pair<const void*, uint32_t>> hotkeyPresses;
uint64_t routed = 0;
uint64_t calls = 0;

// The global-hotkey protocol runs before SeatManager switches its current
// keyboard. Carry the actual event device through that call, not the last
// focused keyboard (which may have a different layout).
bool routeKeyEvent(CKeybindManager* self, std::any event, SP<IKeyboard> keyboard) {
    using KeyEventOriginal = bool (*)(CKeybindManager*, std::any, SP<IKeyboard>);
    struct Context {
        IKeyboard* previous;
        ~Context() { dispatchKeyboard = previous; }
    } context{dispatchKeyboard};
    dispatchKeyboard = keyboard.get();
    return reinterpret_cast<KeyEventOriginal>(keyEventHook->m_original)(self, std::move(event), std::move(keyboard));
}

xkb_keysym_t clientSymbol(IKeyboard* keyboard, uint32_t code) {
    // On a switch between identical keymaps, setKeyboard() sends no keymap
    // or modifiers before the key. Qt therefore still uses the previous
    // seat keyboard's layout group for this first event. Reserve what the
    // client will actually receive, not a chord it cannot handle yet. The
    // following modifier event updates the group through the native path.
    auto seated = g_pSeatManager->m_keyboard.lock();
    if (keyboard && seated && keyboard != seated.get()
        && keyboard->m_xkbKeymapV1String == seated->m_xkbKeymapV1String)
        keyboard = seated.get();
    return keyboard && keyboard->m_xkbState
        ? xkb_state_key_get_one_sym(keyboard->m_xkbState, code) : XKB_KEY_NoSymbol;
}

SP<View> focusedView() {
    auto resource = g_pSeatManager->m_state.keyboardFocus.lock();
    auto surface = Surface::fromResource(resource);
    if (!surface) return nullptr;
    auto view = surface->view();
    if (view && view->type() == Desktop::View::VIEW_TYPE_POPUP) {
        auto popup = Desktop::View::CPopup::fromView(view);
        auto owner = popup ? popup->getT1Owner() : nullptr;
        return owner ? owner->view() : nullptr;
    }
    return view;
}

bool isAskView(const SP<View>& view, pid_t pid, const std::string& name) {
    if (!view || !view->aliveAndVisible()) return false;
    if (auto layer = Desktop::View::CLayerSurface::fromView(view))
        return layer->getPID() == pid && layer->m_namespace == name
            && (name == "omarchy-ask" || name == "omarchy-ask-harness"
                || name == "omarchy-ask-motion");
    if (auto window = Desktop::View::CWindow::fromView(view))
        return window->getPID() == pid && window->m_title == name
            && name.starts_with("Omarchy Ask #");
    return false;
}

SP<View> mappedAskView(pid_t pid, const std::string& name) {
    // Register before the layer requests keyboard focus. Match one live
    // surface, never a saved PID/title template that could outlive its owner.
    SP<View> result;
    for (const auto& layer : Desktop::viewState()->layers()) {
        if (!isAskView(layer, pid, name)) continue;
        if (result) return nullptr; // ambiguous names must not claim both
        result = layer;
    }
    for (const auto& window : Desktop::viewState()->windows()) {
        if (!isAskView(window, pid, name)) continue;
        if (result) return nullptr;
        result = window;
    }
    return result;
}

bool owns(const SP<View>& view, uint32_t mods, xkb_keysym_t sym) {
    // Caps/NumLock do not create new shortcuts. All other modifier bits remain
    // meaningful: Ctrl+H must not claim Super+H or Ctrl+Alt+H.
    mods &= ~(2u | 16u);
    for (const auto& scope : scopes) {
        if (scope.owner.lock() != view) continue;
        for (const auto& chord : scope.chords)
            if (chord.mods == mods && chord.sym == xkb_keysym_to_lower(sym))
                return true;
    }
    return false;
}

SDispatchResult route(CKeybindManager* self, uint32_t mods,
        const SPressedKeyWithMods& key, bool pressed,
        SP<IKeyboard> keyboard, SP<IHID> device) {
    ++calls;
    auto original = reinterpret_cast<Original>(hook->m_original);
    if (key.keycode == 0 || !key.keyName.empty())
        return original(self, mods, key, pressed, keyboard, device);

    const auto id = std::make_pair(static_cast<const void*>(device.get()), key.keycode);
    bool forward = false;
    if (pressed) {
        auto view = focusedView();
        forward = !g_pSessionLockManager->isSessionLocked()
            && view && view->aliveAndVisible() && owns(view, mods, clientSymbol(keyboard.get(), key.keycode));
        if (forward) presses[id] = true;
        else presses.erase(id);
    } else {
        auto it = presses.find(id);
        if (it != presses.end()) {
            forward = it->second && !g_pSessionLockManager->isSessionLocked();
            presses.erase(it);
        }
    }
    if (forward) {
        // handleKeybinds normally updates these before matching any binding.
        // Keep that bookkeeping even when Ask owns this chord: a subsequent
        // distinct multi-key shortcut may depend on this key being held.
        // This is input state only; no user binding is disabled or rewritten.
        if (key.keysym != XKB_KEY_NoSymbol) {
            auto& held = self->keycodeToModifier(key.keycode) ? self->m_mkMods : self->m_mkKeys;
            if (pressed) held.emplace(key.keysym, key.keycode);
            else std::erase_if(held, [&key](const auto& k) {
                return k.first == key.keysym || k.second == key.keycode;
            });
        }
        ++routed;
        return {.passEvent = true, .success = true, .error = {}};
    }
    return original(self, mods, key, pressed, keyboard, device);
}

// Client-managed global hotkeys run before regular compositor bindings.
// Preserve their normal dispatcher for every unclaimed chord as well.
bool routeHotkey(CHotkeyProtocol* self, xkb_keysym_t sym, uint32_t mods,
                 uint32_t code, bool pressed, uint32_t time) {
    using HotkeyOriginal = bool (*)(CHotkeyProtocol*, xkb_keysym_t, uint32_t, uint32_t, bool, uint32_t);
    auto original = reinterpret_cast<HotkeyOriginal>(hotkeyHook->m_original);
    const auto id = std::make_pair(static_cast<const void*>(dispatchKeyboard), code);
    if (pressed) {
        auto view = focusedView();
        if (!g_pSessionLockManager->isSessionLocked() && view && view->aliveAndVisible()
            && owns(view, mods, clientSymbol(dispatchKeyboard, code))) {
            hotkeyPresses.insert(id);
            return false; // regular key pipeline will route it to the surface
        }
        hotkeyPresses.erase(id);
    } else if (hotkeyPresses.erase(id) && !g_pSessionLockManager->isSessionLocked()) {
        return false;
    }
    return original(self, sym, mods, code, pressed, time);
}

// Explicit parameterization, not a mirrored keymap. Input contains only Ask's
// own chords. Registration requires a uniquely matched, live mapped surface;
// precedence itself is restricted to that surface while it has focus.
// Format: askshortcuts set PID "surface-name" MOD:KEYSYM ...
std::string configure(eHyprCtlOutputFormat, std::string request) {
    if (request.size() > 16384) return "error: scope request too large";
    std::erase_if(scopes, [](const Scope& s) { return !s.owner.lock(); });
    std::istringstream in(request);
    std::string verb, action;
    in >> verb >> action;
    if (action == "info")
        return std::string("{\"protocol\":1,\"abi\":\"") + __hyprland_api_get_client_hash()
            + "\",\"build\":\"" + ASK_SCOPE_BUILD_ID + "\"}";
    if (action == "status")
        return "scopes=" + std::to_string(scopes.size()) + " routed=" + std::to_string(routed)
            + " calls=" + std::to_string(calls) + " active=" + std::to_string(g_pCompositor->m_sessionActive);
    if (action != "set" && action != "focus-ready") return "error: expected set, focus-ready, info, or status";
    pid_t pid = 0;
    std::string name;
    in >> pid >> std::quoted(name);
    auto view = mappedAskView(pid, name);
    if (!in || !view) return "error: Ask surface is not uniquely mapped";
    if (action == "focus-ready") {
        // A pin handoff must confirm the old layer's focus hold has reached
        // the compositor before mapping a new toplevel. This is a read-only
        // acknowledgement, not a compositor-driven grab or focus mutation.
        auto layer = Desktop::View::CLayerSurface::fromView(view);
        return layer && focusedView() == view
            && layer->m_layerSurface->m_current.interactivity == ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE
            ? "ok" : "error: focus hold is not committed";
    }

    std::vector<Chord> chords;
    std::string word;
    while (in >> word) {
        if (chords.size() >= 128) return "error: too many chords";
        auto colon = word.find(':');
        if (colon == std::string::npos) return "error: malformed chord";
        uint32_t mods = 0;
        auto digits = word.substr(0, colon);
        if (digits.empty() || digits.find_first_not_of("0123456789") != std::string::npos)
            return "error: malformed modifiers";
        try {
            auto value = std::stoul(digits);
            if (value > std::numeric_limits<uint32_t>::max()) return "error: malformed modifiers";
            mods = value;
        } catch (...) { return "error: malformed modifiers"; }
        if (mods & ~uint32_t{1 | 4 | 8 | 64 | 128}) return "error: unsupported modifiers";
        auto sym = xkb_keysym_from_name(word.c_str() + colon + 1, XKB_KEYSYM_CASE_INSENSITIVE);
        if (sym == XKB_KEY_NoSymbol) return "error: unknown keysym";
        chords.push_back({mods, xkb_keysym_to_lower(sym)});
    }
    std::erase_if(scopes, [&](const Scope& s) { return s.owner.lock() == view; });
    scopes.push_back({view, std::move(chords)});
    return "ok";
}
}

APICALL EXPORT std::string PLUGIN_API_VERSION() { return HYPRLAND_API_VERSION; }

APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
    pluginHandle = handle;
    if (std::string(__hyprland_api_get_hash()) != __hyprland_api_get_client_hash())
        throw std::runtime_error("Ask shortcut scope: Hyprland ABI mismatch; rebuild for this compositor");
    std::vector<SFunctionMatch> eventMatches;
    for (const auto& match : HyprlandAPI::findFunctionsByName(handle, "onKeyEvent"))
        if (match.demangled.starts_with("CKeybindManager::onKeyEvent(")) eventMatches.push_back(match);
    if (eventMatches.size() != 1)
        throw std::runtime_error("Ask shortcut scope: unsupported keyboard event ABI");
    keyEventHook = HyprlandAPI::createFunctionHook(handle, eventMatches[0].address, reinterpret_cast<void*>(&routeKeyEvent));
    if (!keyEventHook || !keyEventHook->hook()) throw std::runtime_error("Ask shortcut scope: keyboard event hook failed");
    auto matches = HyprlandAPI::findFunctionsByName(handle, "handleKeybinds");
    std::vector<SFunctionMatch> exact;
    for (const auto& match : matches)
        if (match.demangled.starts_with("CKeybindManager::handleKeybinds(")) exact.push_back(match);
    if (exact.size() != 1)
        throw std::runtime_error("Ask shortcut scope: unsupported keybind dispatch ABI");
    hook = HyprlandAPI::createFunctionHook(handle, exact[0].address, reinterpret_cast<void*>(&route));
    if (!hook || !hook->hook()) throw std::runtime_error("Ask shortcut scope: hook failed");
    exact.clear();
    for (const auto& match : HyprlandAPI::findFunctionsByName(handle, "onKey"))
        if (match.demangled.starts_with("CHotkeyProtocol::onKey(")) exact.push_back(match);
    if (exact.size() != 1)
        throw std::runtime_error("Ask shortcut scope: unsupported global hotkey ABI");
    hotkeyHook = HyprlandAPI::createFunctionHook(handle, exact[0].address, reinterpret_cast<void*>(&routeHotkey));
    if (!hotkeyHook || !hotkeyHook->hook()) throw std::runtime_error("Ask shortcut scope: global hotkey hook failed");
    command = HyprlandAPI::registerHyprCtlCommand(handle,
        {.name = "askshortcuts", .exact = false, .fn = configure});
    if (!command) throw std::runtime_error("Ask shortcut scope: command registration failed");
    g_pEventManager->postEvent({"askshortcuts", "ready"});
    return {"ask-shortcut-scope", "Focused Ask shortcut precedence", "Clickety Clacks", "0.1.0-experimental"};
}

APICALL EXPORT void PLUGIN_EXIT() {
    g_pEventManager->postEvent({"askshortcuts", "unavailable"});
    if (command) HyprlandAPI::unregisterHyprCtlCommand(pluginHandle, command);
    command.reset();
    scopes.clear();
    presses.clear();
    hotkeyPresses.clear();
}
