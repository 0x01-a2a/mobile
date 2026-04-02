#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
NODE_DIR="$ROOT_DIR/node"
ZEROCLAW_DIR="$ROOT_DIR/zeroclaw"
IOS_LIBS_DIR="$MOBILE_DIR/ios/libs"
IOS_TARGET="aarch64-apple-ios"

echo "Building zerox1-node iOS static library..."
(
  cd "$NODE_DIR/crates/zerox1-node"
  cargo build --release --target "$IOS_TARGET" --features ios-ffi
)

echo "Building zeroclaw iOS static library..."
(
  cd "$ZEROCLAW_DIR"
  cargo build --release --target "$IOS_TARGET" --features ios-ffi,channel-zerox1
)

mkdir -p "$IOS_LIBS_DIR"
cp "$NODE_DIR/target/$IOS_TARGET/release/libzerox1_node.a" "$IOS_LIBS_DIR/libzerox1_node.a"
cp "$ZEROCLAW_DIR/target/$IOS_TARGET/release/libzeroclaw.a" "$IOS_LIBS_DIR/libzeroclaw.a"

echo "Updated iOS static libraries in $IOS_LIBS_DIR"
