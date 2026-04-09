#!/bin/bash
# Build zerox1-node and zeroclaw as XCFrameworks for iOS.
#
# XCFrameworks bundle both the device (aarch64-apple-ios) and simulator
# (aarch64-apple-ios-sim + x86_64-apple-ios) slices in one package.
# Xcode automatically picks the right slice — no more simulator/device confusion.
#
# Output:
#   ios/libs/zerox1_node.xcframework
#   ios/libs/zeroclaw.xcframework
#
# Usage:
#   ./scripts/build-ios-libs.sh            # both libs
#   ./scripts/build-ios-libs.sh node       # zerox1-node only
#   ./scripts/build-ios-libs.sh zeroclaw   # zeroclaw only

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
NODE_DIR="$ROOT_DIR/node"
ZEROCLAW_DIR="$ROOT_DIR/zeroclaw"
LIBS_DIR="$MOBILE_DIR/ios/libs"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TARGET_DEVICE="aarch64-apple-ios"
TARGET_SIM_ARM="aarch64-apple-ios-sim"
TARGET_SIM_X86="x86_64-apple-ios"

BUILD=${1:-all}

build_node() {
  echo "==> Building zerox1-node (device)..."
  (cd "$NODE_DIR" && cargo build --release --target "$TARGET_DEVICE" -p zerox1-node --features ios-ffi)

  echo "==> Building zerox1-node (simulator arm64)..."
  (cd "$NODE_DIR" && cargo build --release --target "$TARGET_SIM_ARM" -p zerox1-node --features ios-ffi)

  echo "==> Building zerox1-node (simulator x86_64)..."
  (cd "$NODE_DIR" && cargo build --release --target "$TARGET_SIM_X86" -p zerox1-node --features ios-ffi)

  echo "==> Lipo simulator slices for zerox1-node..."
  mkdir -p "$TMP_DIR/node-sim"
  lipo -create \
    "$NODE_DIR/target/$TARGET_SIM_ARM/release/libzerox1_node.a" \
    "$NODE_DIR/target/$TARGET_SIM_X86/release/libzerox1_node.a" \
    -output "$TMP_DIR/node-sim/libzerox1_node.a"

  echo "==> Creating zerox1_node.xcframework..."
  rm -rf "$LIBS_DIR/zerox1_node.xcframework"
  xcodebuild -create-xcframework \
    -library "$NODE_DIR/target/$TARGET_DEVICE/release/libzerox1_node.a" \
    -library "$TMP_DIR/node-sim/libzerox1_node.a" \
    -output "$LIBS_DIR/zerox1_node.xcframework"
  echo "    -> $LIBS_DIR/zerox1_node.xcframework"
}

build_zeroclaw() {
  echo "==> Building zeroclaw (device)..."
  (cd "$ZEROCLAW_DIR" && cargo build --release --target "$TARGET_DEVICE" --features ios-ffi,channel-zerox1)

  echo "==> Building zeroclaw (simulator arm64)..."
  (cd "$ZEROCLAW_DIR" && cargo build --release --target "$TARGET_SIM_ARM" --features ios-ffi,channel-zerox1)

  echo "==> Building zeroclaw (simulator x86_64)..."
  (cd "$ZEROCLAW_DIR" && cargo build --release --target "$TARGET_SIM_X86" --features ios-ffi,channel-zerox1)

  echo "==> Lipo simulator slices for zeroclaw..."
  mkdir -p "$TMP_DIR/zeroclaw-sim"
  lipo -create \
    "$ZEROCLAW_DIR/target/$TARGET_SIM_ARM/release/libzeroclaw.a" \
    "$ZEROCLAW_DIR/target/$TARGET_SIM_X86/release/libzeroclaw.a" \
    -output "$TMP_DIR/zeroclaw-sim/libzeroclaw.a"

  echo "==> Creating zeroclaw.xcframework..."
  rm -rf "$LIBS_DIR/zeroclaw.xcframework"
  xcodebuild -create-xcframework \
    -library "$ZEROCLAW_DIR/target/$TARGET_DEVICE/release/libzeroclaw.a" \
    -library "$TMP_DIR/zeroclaw-sim/libzeroclaw.a" \
    -output "$LIBS_DIR/zeroclaw.xcframework"
  echo "    -> $LIBS_DIR/zeroclaw.xcframework"
}

mkdir -p "$LIBS_DIR"

case "$BUILD" in
  node)     build_node ;;
  zeroclaw) build_zeroclaw ;;
  *)        build_node; build_zeroclaw ;;
esac

echo ""
echo "Done. XCFrameworks in $LIBS_DIR:"
echo "  zerox1_node.xcframework  — device (aarch64) + simulator (arm64 + x86_64)"
echo "  zeroclaw.xcframework     — device (aarch64) + simulator (arm64 + x86_64)"
