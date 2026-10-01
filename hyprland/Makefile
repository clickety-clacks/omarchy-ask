CXX ?= c++
ASK_BUILD_DIR ?= .
ASK_SCOPE_BUILD_ID ?= development
CPPFLAGS += $(shell pkg-config --cflags hyprland)
CPPFLAGS += -DASK_SCOPE_BUILD_ID='"$(ASK_SCOPE_BUILD_ID)"'
# The ABI-gated hook maintains native held-key bookkeeping even when dispatch
# is scoped to Ask. These sets are private in the supported Hyprland version.
CXXFLAGS += -std=c++23 -fPIC -fno-gnu-unique -fno-access-control -Wall -Wextra -Werror -O2

.DEFAULT_GOAL := all
.PHONY: all abi
all: $(ASK_BUILD_DIR)/ask-shortcut-scope.so
abi: $(ASK_BUILD_DIR)/abi-probe

$(ASK_BUILD_DIR)/ask-shortcut-scope.so: shortcut-scope.cpp Makefile
	mkdir -p "$(ASK_BUILD_DIR)"
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -shared -o "$@" "$<" -lxkbcommon

$(ASK_BUILD_DIR)/abi-probe: abi-probe.cpp Makefile
	mkdir -p "$(ASK_BUILD_DIR)"
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -o "$@" "$<"

.PHONY: clean
clean:
	$(RM) "$(ASK_BUILD_DIR)/ask-shortcut-scope.so" "$(ASK_BUILD_DIR)/abi-probe"
