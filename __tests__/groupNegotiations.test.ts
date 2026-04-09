/**
 * Unit tests for groupNegotiations.
 *
 * groupNegotiations groups a flat list of InboundEnvelopes (newest-first)
 * into NegotiationThread objects keyed by conversation_id, returning
 * threads most-recently-updated first.
 */

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

import { groupNegotiations, InboundEnvelope } from '../src/hooks/useNodeApi';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Real conversation IDs are hex::encode([u8; 16]) = 32 lowercase hex chars.
const C1 = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const C2 = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';

function makeEnv(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    sender: 'aaa',
    msg_type: 'PROPOSE',
    slot: 1,
    payload_b64: btoa('{}'),          // not a valid negotiation payload — amount stays undefined
    conversation_id: C1,
    ...overrides,
  };
}

/**
 * Encode a negotiation payload: 16-byte little-endian amount prefix + JSON body.
 * Mirrors the SDK encoding consumed by _decodeBidPayload.
 */
function encodePayload(amountMicro: number, body: Record<string, unknown> = {}): string {
  const bodyStr = JSON.stringify(body);
  const bodyBytes = Array.from(bodyStr).map(c => c.charCodeAt(0));
  const bytes = new Array<number>(16 + bodyBytes.length).fill(0);

  // Write 64-bit little-endian (lo 4 bytes + hi 4 bytes)
  const lo = amountMicro >>> 0;
  const hi = Math.floor(amountMicro / 4294967296) >>> 0;
  bytes[0] = lo & 0xff;
  bytes[1] = (lo >>> 8) & 0xff;
  bytes[2] = (lo >>> 16) & 0xff;
  bytes[3] = (lo >>> 24) & 0xff;
  bytes[4] = hi & 0xff;
  bytes[5] = (hi >>> 8) & 0xff;
  bytes[6] = (hi >>> 16) & 0xff;
  bytes[7] = (hi >>> 24) & 0xff;
  // bytes 8-15 stay zero (high bits of i128)
  for (let i = 0; i < bodyBytes.length; i++) bytes[16 + i] = bodyBytes[i];

  return btoa(String.fromCharCode(...bytes));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('groupNegotiations', () => {
  it('returns empty array for empty inbox', () => {
    expect(groupNegotiations([])).toEqual([]);
  });

  it('filters out non-negotiation message types', () => {
    const inbox = [
      makeEnv({ msg_type: 'FEEDBACK' }),
      makeEnv({ msg_type: 'BEACON' }),
      makeEnv({ msg_type: 'ADVERTISE' }),
    ];
    expect(groupNegotiations(inbox)).toEqual([]);
  });

  it('groups a single PROPOSE into a thread', () => {
    const inbox = [makeEnv({ sender: 'buyer', msg_type: 'PROPOSE', conversation_id: C1 })];
    const threads = groupNegotiations(inbox);
    expect(threads).toHaveLength(1);
    expect(threads[0].conversationId).toBe(C1);
    expect(threads[0].counterparty).toBe('buyer');
    expect(threads[0].latestStatus).toBe('PROPOSE');
    expect(threads[0].messages).toHaveLength(1);
  });

  it('groups multiple messages with the same conversation_id into one thread', () => {
    // inbox is newest-first
    const inbox = [
      makeEnv({ msg_type: 'ACCEPT', slot: 3, conversation_id: C1 }),
      makeEnv({ msg_type: 'COUNTER', slot: 2, conversation_id: C1 }),
      makeEnv({ msg_type: 'PROPOSE', slot: 1, conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages).toHaveLength(3);
    expect(threads[0].latestStatus).toBe('ACCEPT');
  });

  it('keeps separate conversation_ids as separate threads', () => {
    const inbox = [
      makeEnv({ msg_type: 'PROPOSE', conversation_id: C2 }),
      makeEnv({ msg_type: 'PROPOSE', conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads).toHaveLength(2);
    const ids = threads.map(t => t.conversationId);
    expect(ids).toContain(C1);
    expect(ids).toContain(C2);
  });

  it('sets counterparty from the first (oldest) message sender', () => {
    // inbox newest-first: c1 has ACCEPT from bbb, then PROPOSE from aaa
    const inbox = [
      makeEnv({ sender: 'bbb', msg_type: 'ACCEPT', slot: 2, conversation_id: C1 }),
      makeEnv({ sender: 'aaa', msg_type: 'PROPOSE', slot: 1, conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads[0].counterparty).toBe('aaa');   // oldest sender
  });

  it('sets latestStatus to the most recent message type', () => {
    const inbox = [
      makeEnv({ msg_type: 'REJECT', slot: 3, conversation_id: C1 }),
      makeEnv({ msg_type: 'COUNTER', slot: 2, conversation_id: C1 }),
      makeEnv({ msg_type: 'PROPOSE', slot: 1, conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads[0].latestStatus).toBe('REJECT');
  });

  it('does not set latestAmount for PROPOSE or REJECT', () => {
    const inbox = [
      makeEnv({ msg_type: 'REJECT', conversation_id: C1 }),
      makeEnv({ msg_type: 'PROPOSE', conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads[0].latestAmount).toBeUndefined();
  });

  it('sets latestAmount from an ACCEPT payload', () => {
    const amountMicro = 1_000_000; // 1 USDC
    const inbox = [
      makeEnv({
        msg_type: 'ACCEPT',
        conversation_id: C1,
        payload_b64: encodePayload(amountMicro, {}),
      }),
      makeEnv({ msg_type: 'PROPOSE', conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads[0].latestAmount).toBe(amountMicro);
  });

  it('sets latestAmount from a COUNTER payload', () => {
    const amountMicro = 500_000; // 0.5 USDC
    const inbox = [
      makeEnv({
        msg_type: 'COUNTER',
        conversation_id: C1,
        payload_b64: encodePayload(amountMicro, { round: 1, max_rounds: 3 }),
      }),
      makeEnv({ msg_type: 'PROPOSE', conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads[0].latestAmount).toBe(amountMicro);
  });

  it('decodes round and maxRounds from a COUNTER payload', () => {
    const inbox = [
      makeEnv({
        msg_type: 'COUNTER',
        conversation_id: C1,
        payload_b64: encodePayload(1_000_000, { round: 2, max_rounds: 5, message: 'ok' }),
      }),
    ];
    const threads = groupNegotiations(inbox);
    const msg = threads[0].messages[0];
    expect(msg.round).toBe(2);
    expect(msg.maxRounds).toBe(5);
    expect(msg.message).toBe('ok');
  });

  it('returns threads most-recently-updated first', () => {
    // c2 has a more recent message (slot 3) than c1 (slot 1)
    // inbox is newest-first
    const inbox = [
      makeEnv({ msg_type: 'ACCEPT',  slot: 3, conversation_id: C2 }),
      makeEnv({ msg_type: 'PROPOSE', slot: 2, conversation_id: C2 }),
      makeEnv({ msg_type: 'PROPOSE', slot: 1, conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    expect(threads[0].conversationId).toBe(C2);
    expect(threads[1].conversationId).toBe(C1);
  });

  it('ignores FEEDBACK mixed in with negotiation messages', () => {
    const inbox = [
      makeEnv({ msg_type: 'DELIVER',  conversation_id: C1 }),
      makeEnv({ msg_type: 'ACCEPT',   conversation_id: C1 }),
      makeEnv({ msg_type: 'FEEDBACK', conversation_id: C1 }),  // filtered out
      makeEnv({ msg_type: 'PROPOSE',  conversation_id: C1 }),
    ];
    const threads = groupNegotiations(inbox);
    // DELIVER is in NEGOTIATION_TYPES; FEEDBACK is not — expect 3 messages
    expect(threads[0].messages).toHaveLength(3);
  });
});
