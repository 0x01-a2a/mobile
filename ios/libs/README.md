# iOS native libraries

These archives are generated locally from sibling Rust workspaces and are intentionally not tracked in git:

- `libzerox1_node.a` comes from `/Users/tobiasd/Desktop/zerox1/node`
- `libzeroclaw.a` comes from `/Users/tobiasd/Desktop/zerox1/zeroclaw`

Rebuild them with:

```bash
./scripts/build-ios-libs.sh
```

The Xcode project still links `ios/libs/libzerox1_node.a` and `ios/libs/libzeroclaw.a`, so the files must exist locally before building the iOS app.
