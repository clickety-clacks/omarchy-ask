#include <hyprland/src/version.h>
#include <iostream>
#include <string>
#include <string_view>

// Probe the installed development headers in a separate process. Never load
// a candidate module into the compositor just to discover its ABI.
int main() {
    // The ABI formula in PluginAPI.hpp for the explicitly supported commit.
    // Including PluginAPI.hpp itself would initialize compositor-only global
    // objects and prevent a standalone executable from linking.
    auto strip = [](std::string_view version) {
        return std::string(version.substr(0, version.find_last_of('.')));
    };
    std::cout << GIT_COMMIT_HASH << "_aq_" << strip(AQUAMARINE_VERSION)
        << "_hu_" << strip(HYPRUTILS_VERSION) << "_hg_" << strip(HYPRGRAPHICS_VERSION)
        << "_hc_" << strip(HYPRCURSOR_VERSION) << "_hlg_" << strip(HYPRLANG_VERSION) << '\n';
}
