/**
 * useNode — manages node lifecycle and persists config to AsyncStorage.
 *
 * On mount: reads saved config and starts node if auto_start is enabled.
 * Exposes start/stop and the current running state.
 */
import { useState, useEffect, useCallback, useRef, useContext, createContext, ReactNode } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NodeModule, NodeConfig, NodeStatus, onNodeStatus } from '../native/NodeModule';
import { configureNodeApi, loadTokenFromKeychain, loadBagsApiKey } from './useNodeApi';

const STORAGE_KEYS = {
  CONFIG: 'zerox1:node_config',
  AUTO_START: 'zerox1:auto_start',
  BRAIN: 'zerox1:agent_brain',
  BACKGROUND_NODE: 'zerox1:background_node',
};

// How long the app must be in background before the node is idle-stopped (ms).
const IDLE_STOP_DELAY_MS = 60_000;

const LOCAL_NODE_API_BASE = 'http://127.0.0.1:9090';
const LOCAL_NODE_WS_BASE = 'ws://127.0.0.1:9090';

// Module-level lock: if a startNode() call is already in flight, subsequent
// callers (e.g. NodeAutoStarter + EarnScreen both mounting with auto_start=true)
// await the same promise instead of firing a second startForegroundService.
let _startLock: Promise<void> | null = null;

async function configureLocalNodeApi() {
  try {
    const auth = await NodeModule.getLocalAuthConfig();
    configureNodeApi({
      apiBase: LOCAL_NODE_API_BASE,
      wsBase: LOCAL_NODE_WS_BASE,
      token: auth.nodeApiToken ?? undefined,
    });
  } catch {
    configureNodeApi({
      apiBase: LOCAL_NODE_API_BASE,
      wsBase: LOCAL_NODE_WS_BASE,
      token: undefined,
    });
  }
}

/**
 * Retrieve the Bags.fm API key from the OS Keychain and merge it into a
 * startNode config. Returns the base config unchanged if no key is stored.
 */
async function withBagsConfig(base: NodeConfig): Promise<NodeConfig> {
  try {
    const key = await loadBagsApiKey();
    if (!key) return base;
    return { ...base, bagsApiKey: key };
  } catch {
    return base;
  }
}

/**
 * Read the agent brain config from AsyncStorage and merge it into a
 * startNode config object. Returns the base config unchanged if brain is
 * disabled, not set up, or the read fails.
 */
async function withBrainConfig(base: NodeConfig): Promise<NodeConfig> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.BRAIN);
    if (!raw) return base;
    const brain = JSON.parse(raw);
    if (!brain.enabled || !brain.apiKeySet) return base;
    return {
      ...base,
      agentBrainEnabled: true,
      llmProvider: brain.provider ?? 'gemini',
      llmModel: brain.customModel ?? '',
      llmBaseUrl: brain.customBaseUrl ?? '',
      capabilities: JSON.stringify(brain.capabilities ?? []),
      minFeeUsdc: brain.minFeeUsdc ?? 0.01,
      minReputation: brain.minReputation ?? 50,
      autoAccept: brain.autoAccept ?? true,
    };
  } catch {
    return base;
  }
}

// ── Shared context ─────────────────────────────────────────────────────────────
// Allows all screens to share one useNode instance so config changes
// (e.g. agent name saved in Settings) propagate everywhere immediately.

type NodeContextValue = ReturnType<typeof useNodeInternal>;
const NodeContext = createContext<NodeContextValue | null>(null);

export function NodeProvider({ children }: { children: ReactNode }) {
  const value = useNodeInternal();
  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>;
}

export function useNode(): NodeContextValue {
  const ctx = useContext(NodeContext);
  if (ctx) return ctx;
  // Fallback: called outside provider (e.g. tests) — create a local instance.
  return useNodeInternal(); // eslint-disable-line react-hooks/rules-of-hooks
}

function useNodeInternal() {
  const [status, setStatus] = useState<NodeStatus>('stopped');
  const [config, setConfigState] = useState<NodeConfig>({});
  const [autoStart, setAutoStart] = useState(false);
  const [backgroundNode, setBackgroundNodeState] = useState(false);
  const [loading, setLoading] = useState(true);

  // Refs used by the AppState handler (avoid stale closure issues).
  const backgroundNodeRef = useRef(false);
  const configRef = useRef<NodeConfig>({});
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleStoppedRef = useRef(false); // true if we stopped the node on idle

  // Subscribe to native status events
  useEffect(() => {
    return onNodeStatus(({ status: s }) => setStatus(s));
  }, []);

  // Load persisted config on mount
  useEffect(() => {
    (async () => {
      try {
        const [savedConfig, savedAutoStart, savedBgNode] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.CONFIG),
          AsyncStorage.getItem(STORAGE_KEYS.AUTO_START),
          AsyncStorage.getItem(STORAGE_KEYS.BACKGROUND_NODE),
        ]);
        const bgNode = savedBgNode === 'true';
        backgroundNodeRef.current = bgNode;
        setBackgroundNodeState(bgNode);
        const cfg: NodeConfig = savedConfig ? JSON.parse(savedConfig) : {};
        setConfigState(cfg);
        configRef.current = cfg;
        const auto = savedAutoStart === 'true';
        setAutoStart(auto);
        if (auto) {
          if (cfg.nodeApiUrl) {
            // Hosted mode — configure API and mark running.
            const token = await loadTokenFromKeychain();
            configureNodeApi({
              apiBase: cfg.nodeApiUrl,
              wsBase: cfg.nodeApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
              token: token ?? undefined,
              hosted: true,
            });
            setStatus('running');
          } else {
            if (!_startLock) {
              _startLock = (async () => {
                try {
                  const running = await NodeModule.isRunning();
                  if (!running) await NodeModule.startNode(await withBagsConfig(await withBrainConfig(cfg)));
                  await configureLocalNodeApi();
                } finally {
                  _startLock = null;
                }
              })();
            }
            await Promise.race([
              _startLock,
              new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Node start timed out')), 30_000)),
            ]);
            setStatus('running');
          }
        } else {
          if (cfg.nodeApiUrl) {
            // Non-auto-start hosted mode — still configure API pointers.
            const token = await loadTokenFromKeychain();
            configureNodeApi({
              apiBase: cfg.nodeApiUrl,
              wsBase: cfg.nodeApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
              token: token ?? undefined,
              hosted: true,
            });
            setStatus('running');
          } else {
            const running = await NodeModule.isRunning();
            if (running) {
              await configureLocalNodeApi();
            }
            setStatus(running ? 'running' : 'stopped');
          }
        }
      } catch {
        // Silently absorb init errors — node can be started manually
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // AppState idle detection: stop node after IDLE_STOP_DELAY_MS in background
  // (unless backgroundNode is enabled). Restart when app returns to foreground.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (!backgroundNodeRef.current && !idleTimerRef.current) {
          idleTimerRef.current = setTimeout(async () => {
            idleTimerRef.current = null;
            try {
              const running = await NodeModule.isRunning();
              if (running) {
                await NodeModule.stopNode();
                idleStoppedRef.current = true;
              }
            } catch { /* ignore */ }
          }, IDLE_STOP_DELAY_MS);
        }
      } else if (nextState === 'active') {
        // Clear any pending idle timer.
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        // Restart node if we idle-stopped it.
        if (idleStoppedRef.current) {
          idleStoppedRef.current = false;
          const cfg = configRef.current;
          if (!cfg.nodeApiUrl) {
            (async () => {
              try {
                if (!_startLock) {
                  _startLock = (async () => {
                    try {
                      await NodeModule.startNode(await withBagsConfig(await withBrainConfig(cfg)));
                      await configureLocalNodeApi();
                    } finally {
                      _startLock = null;
                    }
                  })();
                }
                await _startLock;
              } catch { /* ignore */ }
            })();
          }
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      sub.remove();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async (cfg?: NodeConfig) => {
    const effective = cfg ?? config;

    if (effective.nodeApiUrl) {
      // Hosted mode — skip native node, just configure API pointers.
      const token = await loadTokenFromKeychain();
      configureNodeApi({
        apiBase: effective.nodeApiUrl,
        wsBase: effective.nodeApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
        token: token ?? undefined,
        hosted: true,
      });
      setStatus('running');
    } else {
      if (!_startLock) {
        _startLock = (async () => {
          try {
            const running = await NodeModule.isRunning();
            if (!running) await NodeModule.startNode(await withBagsConfig(await withBrainConfig(effective)));
            await configureLocalNodeApi();
          } finally {
            _startLock = null;
          }
        })();
      }
      await Promise.race([
        _startLock,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Node start timed out')), 30_000)),
      ]);
      setStatus('running');
    }

    configRef.current = effective;
    await AsyncStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(effective));
  }, [config]);

  const stop = useCallback(async () => {
    await NodeModule.stopNode();
    setStatus('stopped');
  }, []);

  const saveConfig = useCallback(async (cfg: NodeConfig) => {
    setConfigState(cfg);
    configRef.current = cfg;
    await AsyncStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(cfg));
  }, []);

  const setAutoStartPersisted = useCallback(async (value: boolean) => {
    setAutoStart(value);
    await AsyncStorage.setItem(STORAGE_KEYS.AUTO_START, String(value));
    // Also update Android SharedPreferences via the native module
    // so BootReceiver can read the config on reboot.
  }, []);

  const setBackgroundNodePersisted = useCallback(async (value: boolean) => {
    backgroundNodeRef.current = value;
    setBackgroundNodeState(value);
    await AsyncStorage.setItem(STORAGE_KEYS.BACKGROUND_NODE, String(value));
  }, []);

  return {
    status,
    config,
    autoStart,
    backgroundNode,
    loading,
    start,
    stop,
    saveConfig,
    setAutoStart: setAutoStartPersisted,
    setBackgroundNode: setBackgroundNodePersisted,
  };
}
