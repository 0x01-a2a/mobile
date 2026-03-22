#ifndef Zerox1_Bridging_Header_h
#define Zerox1_Bridging_Header_h

#include <stdint.h>

// zerox1-node C FFI — implemented in node/crates/zerox1-node/src/ffi.rs
// Compiled as a static library (libzerox1_node.a) for aarch64-apple-ios.
//
// Return values: 0 = success, non-zero = error code.
// Nullable C strings are passed as NULL when not set.

int32_t zerox1_node_start(const char *data_dir,
                           const char *listen_addr,
                           const char *api_secret,
                           const char *identity_key,  // base58 Ed25519 key, nullable (generates new)
                           const char *relay_addr,    // nullable
                           const char *agent_name,    // nullable
                           const char *rpc_url);      // nullable

int32_t zerox1_node_stop(void);
int32_t zerox1_node_is_running(void);

// zeroclaw C FFI — implemented in zeroclaw/src/ffi.rs
// Compiled as a static library (libzeroclaw.a) for aarch64-apple-ios.

int32_t zeroclaw_start(const char *config_path,
                        const char *node_api_url,
                        const char *llm_api_key);     // nullable; prefer Keychain-derived

int32_t zeroclaw_stop(void);

#endif /* Zerox1_Bridging_Header_h */
