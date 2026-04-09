# iOS native libraries

These XCFrameworks are generated locally from sibling Rust workspaces and are intentionally not tracked in git.

| XCFramework | Source |
|---|---|
| `zerox1_node.xcframework` | `/node` — `zerox1-node` crate |
| `zeroclaw.xcframework` | `/zeroclaw` — zeroclaw crate |

Each XCFramework bundles both slices — Xcode picks the right one automatically:
- **Device**: `aarch64-apple-ios`
- **Simulator**: `aarch64-apple-ios-sim` + `x86_64-apple-ios` (lipo'd)

## Rebuild

```bash
# Both libs
./scripts/build-ios-libs.sh

# One lib only
./scripts/build-ios-libs.sh node
./scripts/build-ios-libs.sh zeroclaw
```

The XCFrameworks must exist locally before building the iOS app in Xcode.
