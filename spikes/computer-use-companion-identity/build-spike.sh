#!/usr/bin/env bash
# build-spike.sh — build CindyComputerUseSpike.app
# Creates a minimal .app bundle with ad-hoc signature.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="CindyComputerUseSpike"
APP_BUNDLE="$SCRIPT_DIR/${APP_NAME}.app"
MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"

echo "[build] Cleaning old bundle..."
rm -rf "$APP_BUNDLE"

echo "[build] Creating bundle structure..."
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

echo "[build] Compiling Swift source..."
swiftc \
  -target arm64-apple-macos13.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  "$SCRIPT_DIR/native/main.swift" \
  -o "$MACOS_DIR/$APP_NAME"

echo "[build] Copying Info.plist..."
cp "$SCRIPT_DIR/native/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

echo "[build] Ad-hoc signing bundle..."
codesign --force --deep --sign - "$APP_BUNDLE"

echo "[build] Verifying signature..."
codesign -dv "$APP_BUNDLE" 2>&1 | grep -E "Identifier|Authority|Format"

echo ""
echo "[build] Done: $APP_BUNDLE"
echo "[build] Bundle ID: com.xd.cindy.computer-use.spike"
