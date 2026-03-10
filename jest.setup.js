// Mock the ZeroxNodeModule native module — not available in Jest environment
const { NativeModules } = require('react-native');

NativeModules.ZeroxNodeModule = {
  startNode:             jest.fn(() => Promise.resolve()),
  stopNode:              jest.fn(() => Promise.resolve()),
  isRunning:             jest.fn(() => Promise.resolve(false)),
  getLocalAuthConfig:    jest.fn(() => Promise.resolve({ nodeApiToken: null, gatewayToken: null, heliusApiKey: null })),
  checkPermissions:      jest.fn(() => Promise.resolve({})),
  requestPermission:     jest.fn(() => Promise.resolve(false)),
  saveLlmApiKey:         jest.fn(() => Promise.resolve()),
  uploadBlob:            jest.fn(() => Promise.resolve('')),
  setBridgeCapability:   jest.fn(() => Promise.resolve()),
  getBridgeCapabilities: jest.fn(() => Promise.resolve({})),
  getBridgeActivityLog:  jest.fn(() => Promise.resolve('[]')),
  // Required by NativeEventEmitter
  addListener:           jest.fn(),
  removeListeners:       jest.fn(),
};
