/**
 * Unit tests for the useNode hook.
 *
 * All jest.mock() factories are self-contained (no external variable refs)
 * because jest hoists mock() calls to the top of the file before any
 * const/let declarations run.  Mocks are accessed via jest.requireMock().
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiGet: jest.fn().mockResolvedValue([]),
}));

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn().mockResolvedValue(false),
  setGenericPassword: jest.fn().mockResolvedValue(true),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/native/NodeModule', () => ({
  NodeModule: {
    startNode: jest.fn().mockResolvedValue(undefined),
    stopNode: jest.fn().mockResolvedValue(undefined),
    isRunning: jest.fn().mockResolvedValue(false),
    getLocalAuthConfig: jest.fn().mockResolvedValue({ nodeApiToken: null, gatewayToken: null }),
    checkPermissions: jest.fn().mockResolvedValue({}),
    requestPermission: jest.fn().mockResolvedValue(false),
    saveLlmApiKey: jest.fn().mockResolvedValue(undefined),
    uploadBlob: jest.fn().mockResolvedValue(''),
    getApnsToken: jest.fn().mockResolvedValue(null),
    registerHealthWake: jest.fn().mockResolvedValue(undefined),
    setBridgeCapability: jest.fn().mockResolvedValue(undefined),
    getBridgeCapabilities: jest.fn().mockResolvedValue({}),
    getBridgeActivityLog: jest.fn().mockResolvedValue('[]'),
  },
  onNodeStatus: jest.fn().mockReturnValue(() => {}),
}));

jest.mock('../src/hooks/useAgentBrain', () => ({
  loadLlmApiKey: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/hooks/useNodeApi', () => ({
  ...jest.requireActual('../src/hooks/useNodeApi'),
  configureNodeApi: jest.fn(),
  loadTokenFromKeychain: jest.fn().mockResolvedValue(null),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import React from 'react';
import { act, create } from 'react-test-renderer';
import { useNode } from '../src/hooks/useNode';

// Typed handles to the mocked modules
const AsyncStorage = jest.requireMock('@react-native-async-storage/async-storage') as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
};
const { NodeModule: mockNodeModule } = jest.requireMock('../src/native/NodeModule') as {
  NodeModule: Record<string, jest.Mock>;
};
const { configureNodeApi: mockConfigureNodeApi } = jest.requireMock('../src/hooks/useNodeApi') as {
  configureNodeApi: jest.Mock;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Flush all pending microtasks and macro-tasks so that async useEffect
 * bodies complete before assertions.  Called inside act() so React can
 * process resulting state updates.
 */
const flushPromises = () =>
  act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    // A second yield picks up any further awaits inside the effect chain
    await new Promise<void>(resolve => setImmediate(resolve));
  });

type HookResult = ReturnType<typeof useNode>;

function renderHook(hook: () => HookResult): { current: HookResult } {
  const result = { current: null as unknown as HookResult };
  function HookWrapper() {
    result.current = hook();
    return null;
  }
  act(() => { create(React.createElement(HookWrapper)); });
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useNode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore sensible defaults after clearAllMocks()
    AsyncStorage.getItem.mockResolvedValue(null);
    AsyncStorage.setItem.mockResolvedValue(undefined);
    mockNodeModule.isRunning.mockResolvedValue(false);
    mockNodeModule.startNode.mockResolvedValue(undefined);
    mockNodeModule.stopNode.mockResolvedValue(undefined);
    mockNodeModule.getLocalAuthConfig.mockResolvedValue({ nodeApiToken: null, gatewayToken: null });
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it('sets loading=false and status=stopped after mount', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBe('stopped');
  });

  it('defaults autoStart to false when AsyncStorage has no value', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();
    expect(result.current.autoStart).toBe(false);
  });

  it('defaults config to empty object when AsyncStorage has no value', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();
    expect(result.current.config).toEqual({});
  });

  // ── Persistence ──────────────────────────────────────────────────────────

  it('saveConfig writes config to AsyncStorage and updates state', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    const cfg = { agentName: 'testbot', rpcUrl: 'https://api.devnet.solana.com' };
    await act(async () => { await result.current.saveConfig(cfg); });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'zerox1:node_config',
      JSON.stringify(cfg),
    );
    expect(result.current.config).toEqual(cfg);
  });

  it('setAutoStart(true) writes "true" to AsyncStorage', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.setAutoStart(true); });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('zerox1:auto_start', 'true');
    expect(result.current.autoStart).toBe(true);
  });

  it('setAutoStart(false) writes "false" to AsyncStorage', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.setAutoStart(false); });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('zerox1:auto_start', 'false');
    expect(result.current.autoStart).toBe(false);
  });

  it('restores autoStart=true from AsyncStorage on mount', async () => {
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:auto_start' ? 'true' : null),
    );

    const result = renderHook(() => useNode());
    await flushPromises();

    expect(result.current.autoStart).toBe(true);
  });

  it('restores saved config from AsyncStorage on mount', async () => {
    const saved = { agentName: 'savedbot' };
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:node_config' ? JSON.stringify(saved) : null),
    );

    const result = renderHook(() => useNode());
    await flushPromises();

    expect(result.current.config).toEqual(saved);
  });

  // ── stop() ──────────────────────────────────────────────────────────────

  it('stop() calls NodeModule.stopNode and sets status=stopped', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.stop(); });

    expect(mockNodeModule.stopNode).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('stopped');
  });

  // ── start() local mode ───────────────────────────────────────────────────

  it('start() (local) calls NodeModule.startNode and sets status=running', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.start({ agentName: 'mybot' }); });

    expect(mockNodeModule.startNode).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('running');
  });

  it('start() (local) persists config to AsyncStorage', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    const cfg = { agentName: 'mybot' };
    await act(async () => { await result.current.start(cfg); });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'zerox1:node_config',
      JSON.stringify(cfg),
    );
  });

  it('start() merges enabled brain config into startNode call', async () => {
    const brain = {
      enabled: true,
      apiKeySet: true,
      provider: 'openai',
      capabilities: ['summarization', 'qa'],
      minFeeUsdc: 0.05,
      minReputation: 75,
      autoAccept: false,
    };
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:agent_brain' ? JSON.stringify(brain) : null),
    );

    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.start({ agentName: 'bot' }); });

    const calledWith = mockNodeModule.startNode.mock.calls[0][0];
    expect(calledWith.agentBrainEnabled).toBe(true);
    expect(calledWith.llmProvider).toBe('openai');
    expect(calledWith.capabilities).toBe(JSON.stringify(['summarization', 'qa']));
    expect(calledWith.minFeeUsdc).toBe(0.05);
    expect(calledWith.minReputation).toBe(75);
    expect(calledWith.autoAccept).toBe(false);
  });

  it('start() does not add brain fields when brain is disabled', async () => {
    const brain = { enabled: false, apiKeySet: true, provider: 'openai', capabilities: [] };
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:agent_brain' ? JSON.stringify(brain) : null),
    );

    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.start({ agentName: 'bot' }); });

    expect(mockNodeModule.startNode.mock.calls[0][0].agentBrainEnabled).toBeUndefined();
  });

  it('start() does not add brain fields when apiKeySet is false', async () => {
    const brain = { enabled: true, apiKeySet: false, provider: 'gemini', capabilities: [] };
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:agent_brain' ? JSON.stringify(brain) : null),
    );

    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => { await result.current.start({ agentName: 'bot' }); });

    expect(mockNodeModule.startNode.mock.calls[0][0].agentBrainEnabled).toBeUndefined();
  });

  // ── start() hosted mode ──────────────────────────────────────────────────

  it('start() (hosted) skips NodeModule.startNode', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => {
      await result.current.start({ nodeApiUrl: 'https://host.example.com:9091' });
    });

    expect(mockNodeModule.startNode).not.toHaveBeenCalled();
    expect(result.current.status).toBe('running');
  });

  it('start() (hosted) configures API with correct apiBase', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => {
      await result.current.start({ nodeApiUrl: 'https://host.example.com:9091' });
    });

    expect(mockConfigureNodeApi).toHaveBeenCalledWith(
      expect.objectContaining({ apiBase: 'https://host.example.com:9091' }),
    );
  });

  it('start() (hosted) converts https → wss for wsBase', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => {
      await result.current.start({ nodeApiUrl: 'https://host.example.com:9091' });
    });

    expect(mockConfigureNodeApi).toHaveBeenCalledWith(
      expect.objectContaining({ wsBase: 'wss://host.example.com:9091' }),
    );
  });

  it('start() (hosted) converts http → ws for wsBase', async () => {
    const result = renderHook(() => useNode());
    await flushPromises();

    await act(async () => {
      await result.current.start({ nodeApiUrl: 'http://localhost:9091' });
    });

    expect(mockConfigureNodeApi).toHaveBeenCalledWith(
      expect.objectContaining({ wsBase: 'ws://localhost:9091' }),
    );
  });

  // ── Auto-start on mount ──────────────────────────────────────────────────

  it('calls startNode on mount when auto_start=true and node is not running', async () => {
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:auto_start' ? 'true' : null),
    );
    mockNodeModule.isRunning.mockResolvedValue(false);

    renderHook(() => useNode());
    await flushPromises();

    expect(mockNodeModule.startNode).toHaveBeenCalledTimes(1);
  });

  it('does not call startNode again if node is already running on mount', async () => {
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:auto_start' ? 'true' : null),
    );
    mockNodeModule.isRunning.mockResolvedValue(true);

    renderHook(() => useNode());
    await flushPromises();

    expect(mockNodeModule.startNode).not.toHaveBeenCalled();
  });

  it('does not call startNode on mount when auto_start=false', async () => {
    AsyncStorage.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === 'zerox1:auto_start' ? 'false' : null),
    );

    renderHook(() => useNode());
    await flushPromises();

    expect(mockNodeModule.startNode).not.toHaveBeenCalled();
  });
});
