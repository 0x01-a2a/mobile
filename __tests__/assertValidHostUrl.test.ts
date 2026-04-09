/**
 * Unit tests for assertValidHostUrl.
 *
 * This function is security-sensitive: it must ensure remote node URLs
 * use HTTPS, and only permit HTTP for local development (loopback).
 */

// Mock module-level side effects so importing useNodeApi doesn't touch native APIs.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  multiGet: jest.fn(),
}));

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

jest.mock('../src/native/NodeModule', () => ({
  NodeModule: {
    startNode: jest.fn(),
    stopNode: jest.fn(),
    isRunning: jest.fn(),
    getLocalAuthConfig: jest.fn(),
    checkPermissions: jest.fn(),
    requestPermission: jest.fn(),
    saveLlmApiKey: jest.fn(),
    uploadBlob: jest.fn(),
    setBridgeCapability: jest.fn(),
    getBridgeCapabilities: jest.fn(),
    getBridgeActivityLog: jest.fn(),
  },
  onNodeStatus: jest.fn(() => () => {}),
}));

import { assertValidHostUrl } from '../src/hooks/useNodeApi';

describe('assertValidHostUrl', () => {
  // ── Valid: HTTPS (any host) ─────────────────────────────────────────────────

  it('accepts https remote host', () => {
    expect(() => assertValidHostUrl('https://node.example.com')).not.toThrow();
  });

  it('accepts https with port', () => {
    expect(() => assertValidHostUrl('https://node.example.com:9091')).not.toThrow();
  });

  it('accepts https with path', () => {
    expect(() => assertValidHostUrl('https://node.example.com/api')).not.toThrow();
  });

  it('accepts https with IP address', () => {
    expect(() => assertValidHostUrl('https://203.0.113.5:9091')).not.toThrow();
  });

  it('accepts https://localhost (loopback over https is fine)', () => {
    expect(() => assertValidHostUrl('https://localhost')).not.toThrow();
  });

  // ── Valid: HTTP loopback only ───────────────────────────────────────────────

  it('accepts http://localhost', () => {
    expect(() => assertValidHostUrl('http://localhost')).not.toThrow();
  });

  it('accepts http://localhost with port', () => {
    expect(() => assertValidHostUrl('http://localhost:9090')).not.toThrow();
  });

  it('accepts http://127.0.0.1', () => {
    expect(() => assertValidHostUrl('http://127.0.0.1')).not.toThrow();
  });

  it('accepts http://127.0.0.1 with port', () => {
    expect(() => assertValidHostUrl('http://127.0.0.1:9090')).not.toThrow();
  });

  it('accepts http://127.x.x.x (full loopback range)', () => {
    expect(() => assertValidHostUrl('http://127.255.255.255:9090')).not.toThrow();
  });

  // ── Invalid: HTTP on non-loopback ──────────────────────────────────────────

  it('rejects http with a public IP', () => {
    expect(() => assertValidHostUrl('http://203.0.113.5:9090')).toThrow('HTTPS');
  });

  it('rejects http with a private RFC1918 address', () => {
    expect(() => assertValidHostUrl('http://192.168.1.1:9090')).toThrow('HTTPS');
  });

  it('rejects http with a 10.x address', () => {
    expect(() => assertValidHostUrl('http://10.0.0.1')).toThrow('HTTPS');
  });

  it('rejects http with a public domain', () => {
    expect(() => assertValidHostUrl('http://node.example.com')).toThrow('HTTPS');
  });

  // ── Invalid: wrong protocol ─────────────────────────────────────────────────

  it('rejects ws:// protocol', () => {
    expect(() => assertValidHostUrl('ws://node.example.com')).toThrow();
  });

  it('rejects wss:// protocol', () => {
    expect(() => assertValidHostUrl('wss://node.example.com')).toThrow();
  });

  it('rejects ftp:// protocol', () => {
    expect(() => assertValidHostUrl('ftp://node.example.com')).toThrow();
  });

  // ── Invalid: malformed ──────────────────────────────────────────────────────

  it('rejects empty string', () => {
    expect(() => assertValidHostUrl('')).toThrow('Invalid URL');
  });

  it('rejects a plain hostname with no protocol', () => {
    // Parsed as protocol "node.example.com:" — not https or http loopback
    expect(() => assertValidHostUrl('node.example.com:9090')).toThrow();
  });

  it('rejects a random non-URL string', () => {
    expect(() => assertValidHostUrl('not a url')).toThrow('Invalid URL');
  });

  it('rejects a URL with no host', () => {
    expect(() => assertValidHostUrl('https://')).toThrow();
  });
});
