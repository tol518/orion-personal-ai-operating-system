# Build, test, and bundle Orion.app without an Xcode project.
#
# `swift build` produces a bare executable. macOS needs a bundle for the menu bar, notifications,
# and a Keychain identity, so `make app` assembles one around it.

CONFIG ?= release
BUILD_DIR := $(shell swift build -c $(CONFIG) --show-bin-path 2>/dev/null)
APP := build/Orion.app

.PHONY: all build test app run clean lint

all: app

build:
	swift build -c $(CONFIG)

test:
	swift test

# Assemble the .app around the built executable.
#
# The ad-hoc signature at the end is what lets the app hold a stable Keychain identity and ask for
# notification permission. It is not a distribution signature: for that, re-sign with a Developer
# ID and notarize. Re-signing with a different identity makes the existing Keychain item
# unreadable, so the app will ask to pair again.
app: build
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp Resources/Info.plist $(APP)/Contents/Info.plist
	cp $(BUILD_DIR)/OrionApp $(APP)/Contents/MacOS/OrionApp
	printf 'APPL????' > $(APP)/Contents/PkgInfo
	codesign --force --deep --sign - $(APP)
	@echo "Built $(APP)"

run: app
	open $(APP)

clean:
	rm -rf .build build
