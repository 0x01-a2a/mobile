/**
 * useNode — manages node lifecycle and persists config to AsyncStorage.
 *
 * On mount: reads saved config and starts node if auto_start is enabled.
 * Exposes start/stop and the current running state.
 */
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NodeModule, NodeConfig, NodeStatus, onNodeStatus } from '../native/NodeModule';
import { configureNodeApi, loadTokenFromKeychain } from './useNodeApi';
import { loadLlmApiKey } from './useAgentBrain';

const STORAGE_KEYS = {
  CONFIG: 'zerox1:node_config',
  AUTO_START: 'zerox1:auto_start',
  BRAIN: 'zerox1:agent_brain',
};

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
      capabilities: JSON.stringify(brain.capabilities ?? []),
      minFeeUsdc: brain.minFeeUsdc ?? 0.01,
      minReputation: brain.minReputation ?? 50,
      autoAccept: brain.autoAccept ?? true,
    };
  } catch {
    return base;
  }
}

export function useNode() {
  const [status, setStatus] = useState<NodeStatus>('stopped');
  const [config, setConfigState] = useState<NodeConfig>({});
  const [autoStart, setAutoStart] = useState(false);
  const [loading, setLoading] = useState(true);

  // Subscribe to native status events
  useEffect(() => {
    return onNodeStatus(({ status: s }) => setStatus(s));
  }, []);

  // Load persisted config on mount
  useEffect(() => {
    (async () => {
      try {
        const [savedConfig, savedAutoStart] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.CONFIG),
          AsyncStorage.getItem(STORAGE_KEYS.AUTO_START),
        ]);
        const cfg: NodeConfig = savedConfig ? JSON.parse(savedConfig) : {};
        setConfigState(cfg);
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
            });
            setStatus('running');
          } else {
            const running = await NodeModule.isRunning();
            if (!running) await NodeModule.startNode(await withBrainConfig(cfg));
          }
        } else {
          if (cfg.nodeApiUrl) {
            // Non-auto-start hosted mode — still configure API pointers.
            const token = await loadTokenFromKeychain();
            configureNodeApi({
              apiBase: cfg.nodeApiUrl,
              wsBase: cfg.nodeApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
              token: token ?? undefined,
            });
            setStatus('running');
          } else {
            const running = await NodeModule.isRunning();
            setStatus(running ? 'running' : 'stopped');
          }
        }
      } catch (e) {
        // Silently absorb init errors — node can be started manually
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const start = useCallback(async (cfg?: NodeConfig) => {
    const effective = cfg ?? config;

    if (effective.nodeApiUrl) {
      // Hosted mode — skip native node, just configure API pointers.
      const token = await loadTokenFromKeychain();
      configureNodeApi({
        apiBase: effective.nodeApiUrl,
        wsBase: effective.nodeApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
        token: token ?? undefined,
      });
      setStatus('running');
    } else {
      await NodeModule.startNode(await withBrainConfig(effective));
      setStatus('running');
    }

    await AsyncStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(effective));
  }, [config]);

  const stop = useCallback(async () => {
    await NodeModule.stopNode();
    setStatus('stopped');
  }, []);

  const saveConfig = useCallback(async (cfg: NodeConfig) => {
    setConfigState(cfg);
    await AsyncStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(cfg));
  }, []);

  const setAutoStartPersisted = useCallback(async (value: boolean) => {
    setAutoStart(value);
    await AsyncStorage.setItem(STORAGE_KEYS.AUTO_START, String(value));
    // Also update Android SharedPreferences via the native module
    // so BootReceiver can read the config on reboot.
  }, []);

  return {
    status,
    config,
    autoStart,
    loading,
    start,
    stop,
    saveConfig,
    setAutoStart: setAutoStartPersisted,
  };
}
