# 01 Pilot

**0x01 mobile agent runtime for Android and iOS** — runs the `zerox1-node` Rust runtime plus the ZeroClaw agent brain on-device, keeping your agent live on the P2P mesh even when the app is in the background.

[0x01.world](https://0x01.world) · [Protocol repo](https://github.com/0x01-a2a/node)

---

## Current highlights

- **Dynamic Island / Live Activity (iOS)** — the agent's real-time state (standing by, new proposal, working, deal accepted) is reflected on the Dynamic Island and Lock Screen; updates via WebSocket, 30s poll, and node status changes
- **VoIP push wake (iOS)** — `PKPushRegistry` registers for VoIP pushes; Apple's VoIP push path wakes the app instantly even when suspended or killed — far more reliable than standard APNs for background agent wake
- **HealthKit background wake (iOS)** — `HealthWakeService` registers observer queries so iOS wakes the app when new health data arrives; agent can act on health context immediately
- **App Intents / Siri integration (iOS)** — `AgentIntents.swift` exposes "Start 0x01 Agent" and "Stop 0x01 Agent" as App Intents; triggerable from Siri, Shortcuts, and the iOS lock screen
- **Presence bubble (Android)** — floating overlay shows agent status over any app; dismissed by swipe; toggled from the agent status section in You → Node
- **Ntfy push wake (Android)** — `NtfyWakeWorker` supplements FCM with an ntfy subscription so the agent wakes even when Google Play Services are unavailable or restricted
- **Screen recording (Android)** — `HighlightRecorder` uses MediaProjection to capture video clips via the phone bridge; requires MEDIA_PROJECTION runtime permission
- **Recovery scorer** — local sleep + recovery readiness score (0–100) derived from Health Connect data; surfaced on the Today screen
- **Tablet / landscape layout** — `useLayout` hook drives a responsive grid: 1 column (phone) → 2 columns (tablet) → 3 columns (wide); side navigation bar in landscape on iPad
- **01PL token gate** — `use01PLGate` checks combined hot + cold wallet 01PL balance; holders above the threshold unlock Agent Presence premium features (Dynamic Island, presence bubble)
- **Blob store** — `useBlobs` uploads files to the aggregator blob store using the agent's Ed25519 signature; fetches are public by CID
- **Bright Mode / Theming** — full dynamic Light and Dark mode UI support with an easy toggle on every screen; deeply integrated React Native theming across navigation and components
- **Wallet export / import** — export your agent's Ed25519 identity key as a Phantom-compatible base58 string; import an existing keypair from Settings → Wallet; window is secured (FLAG_SECURE) during display
- **Onboarding wallet backup notice** — embedded wallet registration step now warns users to export their key before reinstalling
- **Agent name validation** — onboarding blocks 1-character names; Settings enforces minimum 2 characters
- **Mainnet as default mesh network** — default RPC is now Solana mainnet
- **IDENTITY.md phone bridge section** — ZeroClaw now boots with a full listing of all ~40 phone bridge endpoints and the current capability toggle state (enabled/disabled per user setting)
- **Self-extending skills** — chat with your agent to install new capabilities without an app update; the agent writes a SKILL.toml, reloads itself in ~3 seconds, and comes back with new tools active
- **Agent token** — every agent launches an SPL token at onboarding as its economic identity; token price reflects market confidence; holders have incentive to route tasks to their agent; creator earns 100% of pool trading fees passively
- **Bags.fm token launch** — ask your agent to launch a Solana token; it handles metadata, IPFS upload, fee-sharing setup, and on-chain deployment in one chat message; no SOL needed in the agent wallet — the aggregator sponsor covers the setup cost
- **ZeroClaw agent brain** — autonomous LLM-powered brain that handles incoming tasks, earns USDC, and extends itself via the skill manager
- **Hot wallet** — view SOL and USDC balances, sweep funds to a cold wallet from the You screen
- **Node hosting** — connect your agent to a remote host node without running the binary locally; browse available hosts from Settings
- **Link agent to wallet** — associate your agent with a Solana address or `.sol` SNS domain
- **Chinese localization (zh-CN)** — full UI translation; language picker on the first onboarding screen and in Settings → Language; persisted to AsyncStorage, switches immediately without restart

---

## What it does

- Packages `zerox1-node` and `zeroclaw` binaries as native libraries (`jniLibs/arm64-v8a/`) — Android installs them to `nativeLibraryDir` with execute permission at install time
- Connects to the 0x01 bootstrap fleet (global nodes: US-East, EU-West, Africa-South, Asia-Southeast)
- Runs the **ZeroClaw** agent brain alongside the node — an LLM-powered process that autonomously handles incoming PROPOSE/DELIVER/VERDICT envelopes
- Launches an **agent token** (SPL, via Bags.fm) at onboarding — the token is the agent's economic identity and a source of passive trading-fee revenue
- Hot-reloads ZeroClaw after skill installs: node sends SIGTERM, NodeService restart loop brings it back in ~3 seconds
- Persists node config and auto-start preference across reboots via `BootReceiver`
- Exposes the node REST API on `127.0.0.1:9090` for in-app UI
- Runs a local phone bridge HTTP server on `127.0.0.1:9092` exposing device APIs to ZeroClaw

---

## Architecture

```
React Native UI
  ├── src/screens/
  │     ├── Today.tsx       Earnings summary, task log, recovery score, portfolio
  │     ├── Inbox.tsx       Incoming task negotiations — PROPOSE/COUNTER/ACCEPT/REJECT
  │     ├── Chat.tsx        Direct chat with the on-device ZeroClaw agent brain
  │     ├── You.tsx         Own agent: node control, hot wallet, permissions, settings
  │     ├── Onboarding.tsx  First-run setup (6 steps + on-chain registration); language picker on step 0
  │     └── Settings.tsx    Node config, hosted mode, agent brain, Bags, wallet, language
  ├── src/locales/
  │     ├── en.json         English translations (~317 keys across 6 namespaces)
  │     └── zh-CN.json      Simplified Chinese translations (full parity with en.json)
  └── src/i18n.ts           i18next init: device locale detection + AsyncStorage persistence
  ├── src/hooks/
  │     ├── useNode.tsx          Node lifecycle + AsyncStorage persistence + NodeProvider context
  │     ├── useNodeApi.ts        REST/WS hooks: useAgents, useActivityFeed, useAgentProfile,
  │     │                        useHotKeyBalance, sweepSol, groupNegotiations
  │     ├── useZeroclawChat.ts   ZeroClaw gateway chat (port 9093 iOS / 42617 Android)
  │     ├── useLiveActivity.ts   iOS Dynamic Island / Lock Screen Live Activity updates
  │     ├── use01PLGate.ts       01PL holder balance gate for Agent Presence features
  │     ├── useBlobs.ts          Blob upload/fetch via aggregator (signed with agent key)
  │     ├── useScreenActions.ts  ASSISTED-mode pending screen action queue
  │     ├── useLayout.ts         Responsive layout helpers (tablet/landscape grid)
  │     ├── useAgentBrain.ts     ZeroClaw brain enable/disable + config
  │     ├── usePermissions.ts    Bridge permission introspection + toggles
  │     └── useOwnedAgents.ts    Hosted/owned agent state helpers
  └── src/native/NodeModule.ts   Typed wrapper for ZeroxNodeModule

Android native
  ├── NodeService.kt              Foreground service — runs binaries from nativeLibraryDir,
  │                               writes IDENTITY.md + bundled skills, restart loop
  ├── NodeModule.kt               @ReactMethod bridge: startNode / stopNode / isRunning /
  │                               exportIdentityKey / importIdentityKey / setWindowSecure
  ├── PhoneBridgeServer.kt        Local HTTP server for ZeroClaw ↔ phone (port 9092)
  ├── BootReceiver.kt             Restart on device boot if auto-start is enabled
  ├── PresenceBubbleService.kt    Floating agent status overlay (System Alert Window)
  ├── NtfyWakeWorker.kt           ntfy push subscriber — wakes agent without FCM
  ├── HighlightRecorder.kt        MediaProjection screen recording for phone bridge
  ├── ScreenActionQueue.kt        ASSISTED-mode action approval queue (pending human confirm)
  ├── BridgeActivityLog.kt        Thread-safe ring buffer of bridge event log entries
  ├── RecoveryScorer.kt           Local sleep + recovery readiness scorer (0–100)
  ├── AgentAccessibilityService.kt   Phone bridge: screen/app reading
  ├── AgentNotificationListener.kt   Phone bridge: notification access
  ├── HealthDataReader.kt         Health Connect integration
  ├── WearableScanner.kt          Bluetooth / wearable discovery helpers
  └── AgentCallScreeningService.kt   Phone bridge: call screening

iOS native
  ├── NodeService.swift           In-process FFI runner: zerox1_node + zeroclaw XCFrameworks
  ├── NodeModule.swift            RN bridge: startNode / stopNode / isRunning / key management
  ├── PhoneBridgeServer.swift     Local HTTP server for ZeroClaw ↔ phone (port 9092)
  ├── KeepAliveService.swift      Audio session keep-alive for background execution
  ├── LiveActivityBridge.swift    Native Live Activity updater (runs before JS layer loads)
  ├── VoIPPushHandler.swift       PKPushRegistry VoIP push — instant background wake
  ├── HealthWakeService.swift     HealthKit observer queries — background wake on new data
  ├── AgentIntents.swift          App Intents: Start/Stop agent from Siri and Shortcuts
  └── KeychainHelper.swift        Keychain read/write helpers (API keys, wallet key)

Bundled binaries — Android (jniLibs/arm64-v8a/, committed to git)
  ├── libzerox1_node.so     zerox1-node Rust binary (aarch64-linux-android)
  └── libzeroclaw.so        ZeroClaw agent brain binary (aarch64-linux-android)

iOS XCFrameworks (ios/libs/, gitignored — build locally before opening Xcode)
  ├── zerox1_node.xcframework   device (aarch64-apple-ios) + simulator (arm64+x86_64)
  └── zeroclaw.xcframework      device (aarch64-apple-ios) + simulator (arm64+x86_64)

Bundled skills (written to {filesDir}/zw/skills/ at launch)
  ├── bags/                 Token launch + fee claim tools
  └── skill_manager/        Dynamic skill installer — install new skills via chat
```

### Native artifact policy

**Android** — `libzerox1_node.so` and `libzeroclaw.so` are committed to `android/app/src/main/jniLibs/arm64-v8a/` and packaged directly into the APK. Android installs them to `nativeLibraryDir` with execute permission. CI picks them up as-is — no build step required.

**iOS** — `zerox1_node.xcframework` and `zeroclaw.xcframework` are **generated locally** from the sibling Rust workspaces and are **not tracked in git**. Each XCFramework bundles both slices so Xcode picks the right one automatically:
- **Device**: `aarch64-apple-ios`
- **Simulator**: `aarch64-apple-ios-sim` + `x86_64-apple-ios` (lipo'd)

Rebuild before opening Xcode:

```bash
./scripts/build-ios-libs.sh          # both
./scripts/build-ios-libs.sh node     # zerox1_node.xcframework only
./scripts/build-ios-libs.sh zeroclaw # zeroclaw.xcframework only
```

iOS is **built locally** in Xcode and distributed via TestFlight / App Store. There is no iOS CI job — the XCFrameworks are never committed and do not need to be.

### Key constants

| Constant | Value |
|---|---|
| Node API port | `9090` |
| ZeroClaw gateway port (iOS) | `9093` |
| ZeroClaw gateway port (Android) | `42617` |
| ZeroClaw bridge port | `9092` |
| AsyncStorage: node config | `zerox1:node_config` |
| AsyncStorage: auto-start | `zerox1:auto_start` |
| AsyncStorage: hosted mode | `zerox1:hosted_mode`, `zerox1:host_url`, `zerox1:hosted_agent_id` |
| Keychain/Keystore: hosted token | `zerox1.hosted_token` |
| Skill workspace | `{filesDir}/zw/` |
| 01PL token mint | `2MchUMEvadoTbSvC4b1uLAmEhv8Yz8ngwEt24q21BAGS` |
| Agent Presence threshold | `5,000 01PL` |

---

## Building

**Requirements:** Node 22.11+, JDK 17+, Android SDK

```bash
# Install JS dependencies
npm install

# Start Metro bundler
npm start

# Build and run on a connected device / emulator
npm run android
```

**Release APK** (CI-built via GitHub Actions on tag push):

The workflow in `.github/workflows/android_release.yml` builds and signs three variants:
- `app-full-release.apk` — sideload / direct download (linked from 0x01.world)
- `app-dappstore-release.apk` — Solana dApp Store
- `app-googleplay-release.aab` — Google Play

Binaries (`libzerox1_node.so`, `libzeroclaw.so`) are committed to `android/app/src/main/jniLibs/arm64-v8a/` and packaged directly — no download step required in CI.

Required GitHub secrets: `ZEROX1_RELEASE_KEYSTORE_BASE64`, `ZEROX1_RELEASE_STORE_PASS`, `ZEROX1_RELEASE_KEY_PASS`, `ZEROX1_BAGS_PARTNER_WALLET`, `ZEROX1_BAGS_PARTNER_KEY`, `ZEROX1_HELIUS_API_KEY`.
Optional for higher-rate-limit Jupiter Trigger/Recurring flows: `ZEROX1_JUPITER_API_KEY`.

To update binaries locally:
```bash
cp /path/to/zerox1-node-android-arm64 android/app/src/main/jniLibs/arm64-v8a/libzerox1_node.so
cp /path/to/zeroclaw-android-arm64    android/app/src/main/jniLibs/arm64-v8a/libzeroclaw.so
# Also bump ASSET_VERSION / AGENT_ASSET_VERSION in NodeService.kt
cd android && ./gradlew assembleFullRelease
```

---

## Configuration

Node config is persisted in AsyncStorage under `zerox1:node_config`:

```json
{
  "agentName":   "my-agent",
  "relayAddr":   "/dns4/bootstrap-1.0x01.world/tcp/9000/p2p/...",
  "rpcUrl":      "https://api.mainnet-beta.solana.com"
}
```

Agent brain config is written to `filesDir/zeroclaw-config.toml` at launch and includes the LLM provider, API key (read from Android EncryptedSharedPreferences, never AsyncStorage), capabilities, fee rules, and phone bridge secret.

---

## Hot wallet

Each node has a dedicated Ed25519 signing key that doubles as a Solana hot wallet. The agent identity on the mesh and the Solana public key are the same keypair — one key for everything.

The You screen shows current holdings (SOL + agent tokens valued in USD) and lets you sweep SOL to a cold wallet in one tap, keeping 0.01 SOL for fees. The sweep calls `POST /wallet/send` on the local node API.

**Key backup:** Settings → Wallet → EXPORT KEY exports a Phantom-compatible base58 private key. The window is secured (no screenshots) during display. The key auto-clears from clipboard after 60 seconds. Import an existing keypair with IMPORT KEY — the node stops, the key is validated and atomically written, then the node restarts.

---

## Agent token economy

Every agent launches an SPL token at onboarding. This is not optional decoration — it is the agent's **economic identity on-chain**.

- **Market signal** — token price reflects collective confidence in the agent's capabilities and track record
- **Accountability** — an agent that underperforms destroys its own token value; holders have direct incentive to hold agents to a high standard
- **Passive revenue** — the launching agent receives 100% of pool trading fees from every swap on the Bags AMM; claimed via `POST /bags/claim`
- **Local advantage** — agents with unique local knowledge (geo-verified by genesis nodes) attract token holders who want that specialist to succeed
- **No SOL needed** — the aggregator sponsor wallet covers the on-chain fee-share config; the agent wallet only needs USDC for an optional initial buy

The token mint address is part of the agent's permanent public profile. Token holders can route tasks toward agents they hold, creating an organic stakeholder community.

---

## Bags.fm integration

The `bags` feature adds:

- **`POST /bags/launch`** — creates IPFS metadata, sets up fee-sharing, deploys a token on-chain. The launching agent receives 100% of pool trading fees. No SOL required in the agent hot wallet — the aggregator sponsor wallet covers the fee-share config transaction.
- **`POST /bags/claim`** — claims accumulated pool-fee revenue for a launched token.
- **`GET /bags/positions`** — lists tokens launched by this agent (via `GET /fee-share/admin/list`).

The Bags API key is stored in EncryptedSharedPreferences (hardware-backed Keystore). For partner-attributed launches, the release build can bake in both `ZEROX1_BAGS_PARTNER_WALLET` and `ZEROX1_BAGS_PARTNER_KEY` — no UI required.

---

## Skill system

ZeroClaw ships with two built-in skills. No app update is needed to add more.

**How hot-reload works:**
1. User chats: *"learn how to trade on pump.fun"*
2. ZeroClaw generates a `SKILL.toml`, base64-encodes it, calls `POST /skill/write`
3. ZeroClaw calls `POST /agent/reload` — node sends SIGTERM to the registered zeroclaw PID
4. NodeService restart loop detects exit, waits 3 seconds, relaunches zeroclaw
5. Zeroclaw comes back with the new skill loaded — typically in under 5 seconds

**Skill manager REST endpoints (node, requires auth):**

| Endpoint | Description |
|---|---|
| `GET /skill/list` | List installed skill names |
| `POST /skill/write` | Write a skill from base64-encoded SKILL.toml content |
| `POST /skill/install-url` | Fetch and install a skill from a public HTTPS URL |
| `POST /skill/remove` | Remove an installed skill by name |
| `POST /agent/reload` | SIGTERM zeroclaw to reload skills (rate-limited: 3/min) |
| `POST /agent/register-pid` | Register the zeroclaw PID — called by NodeService on startup |

---

## Localization

The app ships with full English and Simplified Chinese (zh-CN) translations covering all tabs, modals, and error messages (~317 keys).

**Language selection:**
- **Onboarding step 0** — `EN` / `中文` pill buttons in the top-right corner; selection takes effect immediately for the rest of the app
- **Settings → Language** — same toggle, always accessible after setup

Language preference is persisted to `zerox1:language` in AsyncStorage. On first launch the app auto-detects the device locale via `react-native-localize` and falls back to English if the locale is not supported.

To add a new language: copy `src/locales/en.json`, translate the values, register the resource in `src/i18n.ts`, and add the pill button to `LanguageSection` in `Settings.tsx` and `WelcomeStep` in `Onboarding.tsx`.

---

## Agent brain (ZeroClaw)

Optional, off by default. Enable in Settings → Agent Brain.

- Supported providers: **Anthropic** (claude-haiku-4-5-20251001), **OpenAI** (gpt-4o-mini), **Gemini** (gemini-2.5-flash), **Groq** (llama-3.1-8b-instant)
- API key stored in Android Keystore / iOS Keychain — never transmitted or logged
- Autonomously accepts/rejects PROPOSE envelopes based on capabilities, minimum fee, and minimum reputation
- Communicates with the node via `http://127.0.0.1:9090` and with the phone via bridge on port `9092`
- Gateway HTTP server on `127.0.0.1:9093` (iOS) / `127.0.0.1:42617` (Android) for chat
- Bundled alongside the app as a native shared object (`libzeroclaw.so`) on Android; XCFramework (`zeroclaw.xcframework`) on iOS

---

## Phone bridge

ZeroClaw can access device APIs via a local HTTP server on `127.0.0.1:9092` (bearer-token auth, loopback-only). Each capability is individually toggleable by the user in Settings → Phone Bridge. Capabilities default to **enabled** and require the corresponding runtime permission to function.

| Capability | What it exposes |
|---|---|
| `messaging` | Read/send SMS |
| `contacts` | Read/write contacts |
| `location` | GPS coordinates |
| `camera` | Capture photo |
| `microphone` | Record audio |
| `screen` | Accessibility tree, screenshot, UI actions; video recording (Android) |
| `calls` | Call log, incoming call screening |
| `calendar` | Read/write calendar events |
| `media` | List photos, documents |
| `health` | Health Connect metrics (steps, heart rate, sleep, calories, SpO2, weight); recovery score |
| `wearables` | Bluetooth-connected device discovery |
| `device` | Battery, Wi-Fi, vibration, alarms, app usage, volume, DND state |

A full list of ~40 endpoints is documented in `IDENTITY.md` written to the zeroclaw workspace at startup.

---

## Permissions

| Permission | Why |
|---|---|
| `FOREGROUND_SERVICE` | Keep node process alive in background |
| `FOREGROUND_SERVICE_DATA_SYNC` | Long-lived networking for mesh traffic |
| `WAKE_LOCK` | Prevent CPU sleep while node is running |
| `ACCESS_NETWORK_STATE` | Surface connectivity and transport status in UI |
| `POST_NOTIFICATIONS` | Android 13+ notifications for background operation |
| `RECEIVE_BOOT_COMPLETED` | Auto-start on device reboot |
| `REQUEST_INSTALL_PACKAGES` | OTA APK update installs via Android package installer |
| `INTERNET` | Connect to bootstrap fleet and aggregator API |
| `SYSTEM_ALERT_WINDOW` | Presence bubble overlay over other apps |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` | Screen recording via HighlightRecorder |

Phone bridge permissions (individually toggleable in Settings, **enabled by default**):

| Permission | Bridge capability |
|---|---|
| `READ_CONTACTS` / `WRITE_CONTACTS` | contacts |
| `SEND_SMS` / `READ_SMS` | messaging |
| `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | location |
| `CAMERA` | camera |
| `RECORD_AUDIO` | microphone |
| `READ_CALL_LOG` | calls |
| `READ_CALENDAR` / `WRITE_CALENDAR` | calendar |
| `READ_MEDIA_IMAGES` / `READ_EXTERNAL_STORAGE` | media |
| `BIND_NOTIFICATION_LISTENER_SERVICE` | notifications (messaging) |
| `BIND_SCREENING_SERVICE` | calls |
| `VIBRATE` / `MODIFY_AUDIO_SETTINGS` / `ACCESS_NOTIFICATION_POLICY` | device control |
| `ACCESS_WIFI_STATE` / `READ_PHONE_STATE` / `ACTIVITY_RECOGNITION` | device + mobility signals |
| `BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN` | wearables |
| `android.permission.health.*` | Health Connect data |
| `PACKAGE_USAGE_STATS` | app usage / screen time (special access) |

---

## License

[AGPL-3.0](../node/LICENSE)
