/**
 * useNode — manages node lifecycle and persists config to AsyncStorage.
 *
 * On mount: reads saved config and starts node if auto_start is enabled.
 * Exposes start/stop and the current running state.
 */
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NodeModule, NodeConfig, NodeStatus, onNodeStatus } from '../native/NodeModule';

const STORAGE_KEYS = {
  CONFIG:     'zerox1:node_config',
  AUTO_START: 'zerox1:auto_start',
};

export function useNode() {
  const [status,    setStatus]    = useState<NodeStatus>('stopped');
  const [config,    setConfigState] = useState<NodeConfig>({});
  const [autoStart, setAutoStart]   = useState(false);
  const [loading,   setLoading]     = useState(true);

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
          const running = await NodeModule.isRunning();
          if (!running) await NodeModule.startNode(cfg);
        } else {
          const running = await NodeModule.isRunning();
          setStatus(running ? 'running' : 'stopped');
        }
      } catch (e) {
        console.warn('useNode init error:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const start = useCallback(async (cfg?: NodeConfig) => {
    const effective = cfg ?? config;
    await NodeModule.startNode(effective);
    setStatus('running');
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
