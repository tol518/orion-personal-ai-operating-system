# Build, test, and bundle Orion.app without an Xcode project.
#
# `swift build` produces a bare executable. macOS needs a bundle for the menu bar, notifications,
# a Keychain identity, and App Intents, so `make app` assembles one around it.

CONFIG ?= release
BUILD_DIR := $(shell swift build -c $(CONFIG) --show-bin-path 2>/dev/null)
APP := build/Orion.app
INTENTS_DIR := build/appintents

# App Intents metadata inputs. Xcode generates these as part of a normal build; with SwiftPM they
# have to be produced explicitly, or Siri and Shortcuts never discover the intents.
# SwiftPM moved the built .swiftmodule from <bin-path>/Modules to <bin-path> itself, so both
# are searched below rather than pinning either layout.
TOOLCHAIN := $(shell xcode-select -p)/Toolchains/XcodeDefault.xctoolchain
PROCESSOR := $(TOOLCHAIN)/usr/bin/appintentsmetadataprocessor
SDK := $(shell xcrun --show-sdk-path)
XCODE_VERSION := $(shell xcodebuild -version 2>/dev/null | tail -1 | awk '{print $$3}')
TARGET_TRIPLE := $(shell uname -m)-apple-macos14.0
DEPLOYMENT_TARGET := 14.0

.PHONY: all build test app appintents icon run clean

all: app

build:
	swift build -c $(CONFIG)

test:
	swift test

# Extract App Intents metadata into the bundle.
#
# Two steps, because SwiftPM does neither: the compiler emits const values describing which types
# conform to AppIntent, and the processor turns those into Metadata.appintents. Only Intents.swift
# is compiled here — main.swift has top-level code, which -parse-as-library rejects.
#
# A failure is a warning rather than an error: the app is perfectly usable without Siri, and a
# machine with Command Line Tools but no full Xcode cannot run the processor.
appintents: build
	@mkdir -p $(INTENTS_DIR) $(APP)/Contents/Resources
	@printf '%s' '["AppEntity","AppEnum","AppIntent","AppShortcutsProvider","DynamicOptionsProvider","EntityIdentifierConvertible","EntityQuery","EntityStringConvertible","IndexedEntity","PersistentlyIdentifiable","TransientAppEntity","URLRepresentableEntity","URLRepresentableEnum","URLRepresentableIntent","AssistantIntent","AssistantEntity","AssistantEnum"]' > $(INTENTS_DIR)/protocols.json
	@if [ ! -x "$(PROCESSOR)" ]; then \
		echo "warning: appintentsmetadataprocessor not found — Siri and Shortcuts will not see Orion's intents."; \
		echo "         Install the full Xcode and run: sudo xcode-select -s /Applications/Xcode.app"; \
	else \
		swiftc -c -wmo -parse-as-library -module-name OrionApp \
			-target $(TARGET_TRIPLE) -sdk "$(SDK)" -I "$(BUILD_DIR)" -I "$(BUILD_DIR)/Modules" \
			-emit-const-values-path $(INTENTS_DIR)/OrionApp.swiftconstvalues \
			-Xfrontend -const-gather-protocols-file -Xfrontend $(INTENTS_DIR)/protocols.json \
			-o $(INTENTS_DIR)/OrionApp.o \
			Sources/OrionApp/Intents.swift && \
		ls Sources/OrionApp/*.swift > $(INTENTS_DIR)/sources.txt && \
		echo "$(PWD)/$(INTENTS_DIR)/OrionApp.swiftconstvalues" > $(INTENTS_DIR)/constvals.txt && \
		"$(PROCESSOR)" \
			--output $(APP)/Contents/Resources \
			--toolchain-dir "$(TOOLCHAIN)" \
			--module-name OrionApp \
			--sdk-root "$(SDK)" \
			--xcode-version "$(XCODE_VERSION)" \
			--platform-family macOS \
			--deployment-target $(DEPLOYMENT_TARGET) \
			--target-triple $(TARGET_TRIPLE) \
			--source-file-list $(INTENTS_DIR)/sources.txt \
			--swift-const-vals-list $(INTENTS_DIR)/constvals.txt \
			--force > /dev/null 2>&1 && \
		echo "App Intents metadata written to $(APP)/Contents/Resources/Metadata.appintents" || \
		echo "warning: App Intents metadata extraction failed — Siri will not see Orion's intents."; \
	fi
	@# The step above is deliberately non-fatal, so verify the artifact rather than the exit code:
	@# a build that quietly ships without Siri support is the failure this check exists to catch.
	@if [ ! -s "$(APP)/Contents/Resources/Metadata.appintents/extract.actionsdata" ]; then \
		echo ""; \
		echo "  !!  Orion.app has NO App Intents metadata. Siri will not see its intents."; \
		echo "      The app is otherwise fine; re-run 'make appintents' after fixing the cause."; \
		echo ""; \
	fi

# Compile the icon set into an .icns.
#
# The .iconset is the committed source; the .icns is generated, because a megabyte of binary in
# version control that nobody can diff is worse than one iconutil call at build time.
#
# To regenerate the iconset itself from a new logo:
#   swiftc -O Tools/make-icon.swift -o /tmp/make-icon && /tmp/make-icon <logo.png> Resources/Orion.iconset
icon:
	@mkdir -p build
	@iconutil -c icns Resources/Orion.iconset -o build/Orion.icns && echo "Built build/Orion.icns"

# Assemble the .app around the built executable.
#
# The ad-hoc signature at the end is what lets the app hold a stable Keychain identity, ask for
# notification permission, and register its intents. It is not a distribution signature: for that,
# re-sign with a Developer ID and notarize. Re-signing with a different identity makes the existing
# Keychain item unreadable, so the app will ask to pair again.
#
# Signing runs last on purpose — the signature has to cover Metadata.appintents.
app: build
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp Resources/Info.plist $(APP)/Contents/Info.plist
	$(MAKE) icon
	cp build/Orion.icns $(APP)/Contents/Resources/Orion.icns
	cp $(BUILD_DIR)/OrionApp $(APP)/Contents/MacOS/OrionApp
	printf 'APPL????' > $(APP)/Contents/PkgInfo
	$(MAKE) appintents
	codesign --force --deep --sign - $(APP)
	@echo "Built $(APP)"

run: app
	open $(APP)

clean:
	rm -rf .build build
