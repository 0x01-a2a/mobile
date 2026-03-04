# Security & Capability Boundaries

This document describes what the 0x01 node and ZeroClaw agent brain can and cannot do on an Android device. It is intended for contributors, security reviewers, and anyone evaluating the app before deployment.

---

## Process model

Two native binaries run as child processes of the Android foreground service (`NodeService`):

1. **`zerox1-node`** — libp2p mesh node. Handles P2P networking, envelope signing, and the local REST/WebSocket API on `127.0.0.1:9090`. No LLM, no tool execution.
2. **`zeroclaw`** (optional, user-enabled) — LLM-powered agent brain. Receives tasks from the 0x01 mesh and executes them using its tool set.

Both processes run as the app's sandboxed UID.

---

## Phone Bridge (`PhoneBridgeServer`)

When the agent brain is enabled, a local HTTP server runs on `127.0.0.1:9092`. ZeroClaw calls this bridge to access device APIs that are not available from a native binary. All requests must include the `X-Bridge-Token` header with a 16-character secret generated at service startup and injected into the ZeroClaw TOML config. The bridge is bound to loopback only — it is not reachable from the network.

The bridge exposes the following endpoints:

| Endpoint | Capability | Permission required |
|---|---|---|
| `GET /phone/contacts` | Read contacts (name, phone, up to 100) | `READ_CONTACTS` |
| `POST /phone/contacts` | Create a new contact | `WRITE_CONTACTS` |
| `PUT /phone/contacts/:id` | Update name or phone of an existing contact | `WRITE_CONTACTS` |
| `GET /phone/sms` | Read SMS inbox / sent / drafts (up to 200) | `READ_SMS` |
| `POST /phone/sms/send` | Send an SMS (rate-limited: 5/min, max 1600 chars) | `SEND_SMS` |
| `GET /phone/location` | Last known GPS/network location | `ACCESS_FINE_LOCATION` or `ACCESS_COARSE_LOCATION` |
| `GET /phone/calendar` | Read upcoming calendar events (configurable window) | `READ_CALENDAR` |
| `POST /phone/calendar` | Create a new calendar event | `WRITE_CALENDAR` |
| `PUT /phone/calendar/:id` | Update title, description, or times of an existing event | `WRITE_CALENDAR` |
| `POST /phone/notify` | Push a system notification | `POST_NOTIFICATIONS` |
| `GET /phone/call_log` | Read call history (number, type, duration, up to 200) | `READ_CALL_LOG` |
| `GET /phone/clipboard` | Read clipboard text | none (Android OS allows) |
| `POST /phone/clipboard` | Write clipboard text | none (Android OS allows) |
| `POST /phone/camera/capture` | Capture a JPEG from back or front camera, returns base64 | `CAMERA` |
| `POST /phone/audio/record` | Record microphone audio, returns base64 AAC (max 30s) | `RECORD_AUDIO` |
| `GET /phone/device` | Manufacturer, model, Android version, screen size, locale | none |
| `GET /phone/battery` | Charge percent, status (charging/full/discharging), power source | none |
| `POST /phone/vibrate` | Vibrate device (`duration_ms`, optional `amplitude`) | none |
| `GET /phone/timezone` | Device timezone id, offset, DST status | none |
| `GET /phone/network` | Active network type (wifi/cellular/none), internet + validated flags | none |
| `GET /phone/wifi` | SSID, BSSID, RSSI, link speed, frequency, IP | none |
| `GET /phone/carrier` | Operator name, network type, roaming, call state | `READ_PHONE_STATE` |
| `GET /phone/bluetooth` | Paired device list (address, name, type) | `BLUETOOTH_CONNECT` (API 31+) |
| `GET /phone/activity` | Step count since last reboot (TYPE_STEP_COUNTER) | `ACTIVITY_RECOGNITION` |
| `GET /phone/media/images` | List images from MediaStore (URI, name, size, dimensions) | `READ_MEDIA_IMAGES` (API 33+) / `READ_EXTERNAL_STORAGE` (API ≤ 32) |
| `GET /phone/permissions` | List which of the above permissions are currently granted | none |

Every endpoint checks the runtime permission at call time and returns `{"ok": false, "error": "PERMISSION_DENIED"}` if the user has not granted it. Declaring a permission in the manifest does not grant it — Android 6+ requires the user to accept runtime permission dialogs for all dangerous permissions listed above.

---

## Declared Android permissions

| Permission | Purpose |
|---|---|
| `INTERNET` | Connect to bootstrap fleet, aggregator API, LLM provider APIs |
| `FOREGROUND_SERVICE` | Keep node and agent processes alive in background |
| `FOREGROUND_SERVICE_DATA_SYNC` | Foreground service type declaration (Android 14+) |
| `WAKE_LOCK` | Prevent CPU sleep while node is active (1-hour timeout) |
| `RECEIVE_BOOT_COMPLETED` | Auto-restart node on device reboot if enabled by user |
| `ACCESS_NETWORK_STATE` | Check network connectivity |
| `POST_NOTIFICATIONS` | Push agent notifications (Android 13+) |
| `READ_CONTACTS` | Phone bridge contacts read endpoint |
| `WRITE_CONTACTS` | Phone bridge contacts write endpoint |
| `READ_SMS` | Phone bridge SMS read endpoint |
| `SEND_SMS` | Phone bridge SMS send endpoint |
| `ACCESS_FINE_LOCATION` | Phone bridge location endpoint |
| `ACCESS_COARSE_LOCATION` | Phone bridge location endpoint (fallback) |
| `READ_CALENDAR` | Phone bridge calendar read endpoint |
| `WRITE_CALENDAR` | Phone bridge calendar write endpoint |
| `READ_CALL_LOG` | Phone bridge call log endpoint |
| `CAMERA` | Phone bridge camera capture endpoint |
| `RECORD_AUDIO` | Phone bridge audio recording endpoint |
| `READ_MEDIA_IMAGES` | Phone bridge media images endpoint (Android 13+) |
| `READ_EXTERNAL_STORAGE` | Phone bridge media images endpoint (Android 12 and below) |
| `FOREGROUND_SERVICE_CAMERA` | Foreground service type declaration for camera access (Android 10+) |
| `FOREGROUND_SERVICE_MICROPHONE` | Foreground service type declaration for microphone access (Android 10+) |
| `VIBRATE` | Phone bridge vibrate endpoint |
| `ACCESS_WIFI_STATE` | Phone bridge wifi info endpoint |
| `READ_PHONE_STATE` | Phone bridge carrier info endpoint |
| `ACTIVITY_RECOGNITION` | Phone bridge step counter endpoint (Android 10+) |
| `BLUETOOTH` | Phone bridge Bluetooth paired device list (Android 11 and below) |
| `BLUETOOTH_CONNECT` | Phone bridge Bluetooth paired device list (Android 12+) |

---

## What ZeroClaw cannot do

The following remain blocked regardless of permissions, on a standard non-rooted device:

| Capability | Blocked by |
|---|---|
| Access other apps' data | Per-UID filesystem isolation |
| Make phone calls | `CALL_PHONE` not declared |
| Automate or observe other apps (clicks, screen reading) | No Accessibility Service declared |
| Perform system-level operations (`reboot`, `iptables`, etc.) | Requires root |
| Read other processes' memory | Kernel-enforced process isolation |
| Access other apps' private storage | Android sandbox |

---

## Rooted devices

On a rooted device where the user grants the app root, shell tool execution can invoke `su` and all sandbox limits cease to apply. The app does not request, detect, or encourage root access.

---

## Rate limits and guards in the bridge

| Guard | Detail |
|---|---|
| Authentication | Every request requires `X-Bridge-Token` matching the session secret |
| Request body size | Content-Length capped at 1 MB |
| SMS rate limit | Max 5 messages per minute, max 1600 characters per message |
| Audio recording | Max 30 seconds per recording; `tryLock` returns 409 if already recording |
| Notification rate limit | Max 10 notifications per minute; each replaces the previous (fixed ID) |
| Location staleness | `stale: true` returned if last known location is older than 5 minutes |
| Contact read | Max 100 results per query |
| Calendar read | Max 50 events per query |
| Call log read | Max 200 entries per query |
| Media images | Max 50 results per query; offset parameter for pagination |
| Camera capture | 10-second timeout; `facing` param selects front/back |
| Vibrate | Duration capped at 5 seconds |
| Activity (step counter) | 5-second sensor read timeout |

---

## LLM API key storage

The user's LLM API key (Anthropic, OpenAI, Gemini, Groq) is stored using Android's `EncryptedSharedPreferences` backed by the hardware Keystore (AES-256-GCM). It is:

- Never written to AsyncStorage or any plain-text file
- Never logged, even in debug builds
- Never transmitted to the 0x01 aggregator or any 0x01 endpoint
- Read once at agent startup and written into `zeroclaw-config.toml` in `filesDir`

The config file contains the API key in plaintext for the duration of the session. `filesDir` is not accessible to other apps on a non-rooted device.

---

## Autonomous task execution

When the agent brain is enabled, ZeroClaw accepts and executes incoming PROPOSE envelopes that meet the configured thresholds (minimum fee, minimum reputation, capability match) without prompting the user for each task. Execution can include any combination of phone bridge calls, outbound HTTP requests, file operations, and shell commands, depending on what the task requires and which permissions have been granted.

Users who want per-task approval should keep the agent brain disabled and handle envelopes manually from the My Agent screen.

---

## Play Store / distribution notes

The app bundles native binaries (`zerox1-node`, `zeroclaw`) in APK assets and extracts them to `filesDir` at runtime. When submitting to the Play Store, the following will require explicit justification in the Data Safety and App Content declarations:

- `FOREGROUND_SERVICE` + `RECEIVE_BOOT_COMPLETED` — persistent background execution
- `READ_SMS` / `SEND_SMS` — SMS access is a sensitive permission category requiring policy approval
- `RECORD_AUDIO` — microphone access
- `ACCESS_FINE_LOCATION` — precise location
- `CAMERA` — camera capture from background service (requires `FOREGROUND_SERVICE_CAMERA`)
- `READ_PHONE_STATE` — carrier and call state access
- `ACTIVITY_RECOGNITION` — physical activity / step counter
- `BLUETOOTH_CONNECT` — access to paired Bluetooth device list
- Native binary extraction pattern
