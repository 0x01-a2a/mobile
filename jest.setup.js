// Mock the ZeroxNodeModule native module — not available in Jest environment
const { NativeModules } = require('react-native');

NativeModules.ZeroxNodeModule = {
  startNode:              jest.fn(() => Promise.resolve()),
  stopNode:               jest.fn(() => Promise.resolve()),
  isRunning:              jest.fn(() => Promise.resolve(false)),
  getLocalAuthConfig:     jest.fn(() => Promise.resolve({ nodeApiToken: null, gatewayToken: null, heliusApiKey: null })),
  checkPermissions:       jest.fn(() => Promise.resolve({})),
  requestPermission:      jest.fn(() => Promise.resolve(false)),
  saveLlmApiKey:          jest.fn(() => Promise.resolve()),
  uploadBlob:             jest.fn(() => Promise.resolve('')),
  setBridgeCapability:    jest.fn(() => Promise.resolve()),
  getBridgeCapabilities:  jest.fn(() => Promise.resolve({})),
  getBridgeActivityLog:   jest.fn(() => Promise.resolve('[]')),
  getRegion:              jest.fn(() => Promise.resolve({ region: 'US', brainAvailable: true })),
  saveEmergencyContacts:  jest.fn(() => Promise.resolve()),
  setSafetyEnabled:       jest.fn(() => Promise.resolve()),
  setAgentStatus:         jest.fn(() => Promise.resolve()),
  setAgentTaskType:       jest.fn(() => Promise.resolve()),
  setAggregatorSleepState: jest.fn(() => Promise.resolve()),
  getApnsToken:           jest.fn(() => Promise.resolve(null)),
  registerHealthWake:     jest.fn(() => Promise.resolve()),
  // Required by NativeEventEmitter
  addListener:            jest.fn(),
  removeListeners:        jest.fn(),
};
