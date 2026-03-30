// src/screens/__tests__/Inbox.test.tsx
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import InboxScreen from '../Inbox';

// Build a properly encoded payload (16-byte amount + JSON body)
function makePayload(amountMicro: number, message: string): string {
  const json = JSON.stringify({ message, round: 0 });
  const jsonBytes = Array.from(json).map((c: string) => c.charCodeAt(0));
  const full = new Uint8Array(16 + jsonBytes.length);
  full[0] = amountMicro & 0xff;
  full[1] = (amountMicro >> 8) & 0xff;
  full[2] = (amountMicro >> 16) & 0xff;
  full[3] = (amountMicro >> 24) & 0xff;
  for (let i = 0; i < jsonBytes.length; i++) full[16 + i] = jsonBytes[i];
  return btoa(String.fromCharCode(...Array.from(full)));
}

let capturedCallback: ((env: any) => void) | null = null;

// Mutable state objects — avoids jest.mock TDZ issues (jest.mock is hoisted)
const mockHireState = {
  agents: [] as any[],
  sentOffers: [] as any[],
};
const mockAddOffer = jest.fn();
const mockUpdateStatus = jest.fn();

jest.mock('../../hooks/useNodeApi', () => {
  const actual = jest.requireActual('../../hooks/useNodeApi');
  return {
    useInbox: (cb: any) => { capturedCallback = cb; return { authError: false }; },
    sendEnvelope: jest.fn().mockResolvedValue(true),
    decodeBidPayload: actual.decodeBidPayload,
    useAgents: () => mockHireState.agents,
    useAgentSearch: () => ({ results: [], loading: false }),
    useAgentProfile: () => null,
    useSentOffers: () => ({
      offers: mockHireState.sentOffers,
      addOffer: mockAddOffer,
      updateStatus: mockUpdateStatus,
    }),
    buyAgentToken: jest.fn().mockResolvedValue('not_implemented'),
  };
});

jest.mock('../../hooks/useAgentBrain', () => ({
  useAgentBrain: () => ({ config: { minFeeUsdc: 1.0 }, loading: false }),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
}));

const mockEnvelope = {
  sender: 'abc123',
  conversation_id: 'conv-1',
  msg_type: 'PROPOSE',
  slot: 1,
  payload_b64: makePayload(2_500_000, 'Review Rust code'),
};

function wrap(ui: React.ReactElement) {
  return render(<NavigationContainer>{ui}</NavigationContainer>);
}

const AGENT_WITH_TOKEN = {
  agent_id: 'aaaa1111',
  name: 'Nexus',
  feedback_count: 10,
  total_score: 90,
  average_score: 9.0,
  positive_count: 9,
  negative_count: 1,
  verdict_count: 10,
  trend: 'stable',
  last_seen: Math.floor(Date.now() / 1000),
  token_address: 'So11111111111111111111111111111111111111112',
  price_range_usd: [1, 5] as [number, number],
};

const AGENT_NO_TOKEN = {
  ...AGENT_WITH_TOKEN,
  agent_id: 'bbbb2222',
  name: 'NoToken',
  token_address: undefined,
};

// ── Existing tests (unchanged) ────────────────────────────────────────────────

describe('InboxScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;
    mockHireState.agents = [];
    mockHireState.sentOffers = [];
  });

  it('shows "No new jobs" when empty', () => {
    const { getByText } = wrap(<InboxScreen />);
    expect(getByText('No new jobs')).toBeTruthy();
  });

  it('shows job card when envelope arrives', async () => {
    const { getByText } = wrap(<InboxScreen />);
    await act(async () => { capturedCallback?.(mockEnvelope); });
    expect(getByText('Review Rust code')).toBeTruthy();
    expect(getByText('$2.50')).toBeTruthy();
  });

  it('calls sendEnvelope ACCEPT when job is accepted', async () => {
    const { sendEnvelope } = require('../../hooks/useNodeApi');
    const { getByText } = wrap(<InboxScreen />);
    await act(async () => { capturedCallback?.(mockEnvelope); });
    fireEvent.press(getByText('Review Rust code'));
    await act(async () => { fireEvent.press(getByText(/Accept/)); });
    await waitFor(() => {
      expect(sendEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ msg_type: 'ACCEPT', conversation_id: 'conv-1' }),
      );
    });
  });
});

// ── Hire tab tests ────────────────────────────────────────────────────────────

describe('InboxScreen — Hire tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;
    mockHireState.agents = [];
    mockHireState.sentOffers = [];
  });

  it('shows OFFERS / HIRE / ACTIVE subtab pills', () => {
    const { getByText } = wrap(<InboxScreen />);
    expect(getByText('OFFERS')).toBeTruthy();
    expect(getByText('HIRE')).toBeTruthy();
    expect(getByText('ACTIVE')).toBeTruthy();
  });

  it('default subtab is OFFERS — bounty list is visible', () => {
    const { getByText } = wrap(<InboxScreen />);
    expect(getByText('No new jobs')).toBeTruthy();
  });

  it('tapping HIRE shows empty state when no agents', () => {
    const { getByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('HIRE'));
    expect(getByText('No agents advertising right now')).toBeTruthy();
  });

  it('agent with token_address renders in HIRE tab', () => {
    mockHireState.agents = [AGENT_WITH_TOKEN];
    const { getByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('HIRE'));
    expect(getByText('Nexus')).toBeTruthy();
  });

  it('tapping agent row opens HireAgent modal (description input visible)', () => {
    mockHireState.agents = [AGENT_WITH_TOKEN];
    const { getByText, getByPlaceholderText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('HIRE'));
    fireEvent.press(getByText('Nexus'));
    expect(getByPlaceholderText('Describe what you need...')).toBeTruthy();
  });

  it('Send Offer button is disabled when description is empty', async () => {
    mockHireState.agents = [AGENT_WITH_TOKEN];
    const { sendEnvelope } = require('../../hooks/useNodeApi');
    const { getByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('HIRE'));
    fireEvent.press(getByText('Nexus'));
    fireEvent.press(getByText('Send Offer'));
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it('agent without token_address shows "Can\'t hire — no token" button', () => {
    mockHireState.agents = [AGENT_NO_TOKEN];
    const { getByText, queryByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('HIRE'));
    fireEvent.press(getByText('NoToken'));
    expect(queryByText("Can't hire — no token")).toBeTruthy();
  });

  it('successful send: calls sendEnvelope PROPOSE, addOffer, switches to ACTIVE', async () => {
    mockHireState.agents = [AGENT_WITH_TOKEN];
    const { sendEnvelope } = require('../../hooks/useNodeApi');
    const { getByText, getByPlaceholderText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('HIRE'));
    fireEvent.press(getByText('Nexus'));
    fireEvent.changeText(getByPlaceholderText('Describe what you need...'), 'Translate this doc');
    await act(async () => { fireEvent.press(getByText('Send Offer')); });
    await waitFor(() => {
      expect(sendEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ msg_type: 'PROPOSE', recipient: 'aaaa1111' }),
      );
      expect(mockAddOffer).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'aaaa1111', status: 'pending' }),
      );
    });
    expect(getByText('No active offers')).toBeTruthy();
  });

  it('ACTIVE tab shows empty state when no sent offers', () => {
    const { getByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('ACTIVE'));
    expect(getByText('No active offers')).toBeTruthy();
  });

  it('ACTIVE tab renders pending offer card', () => {
    mockHireState.sentOffers = [{
      conversation_id: 'co1', agent_id: 'a1', agent_name: 'Nexus',
      token_address: 'So111', description: 'Translate doc',
      status: 'pending', sent_at: Date.now(),
    }];
    const { getByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('ACTIVE'));
    expect(getByText('Nexus')).toBeTruthy();
    expect(getByText('Awaiting response')).toBeTruthy();
  });

  it('ACTIVE tab shows Pay & Accept for delivered offer', () => {
    mockHireState.sentOffers = [{
      conversation_id: 'co2', agent_id: 'a1', agent_name: 'Nexus',
      token_address: 'So111', description: 'Translate doc',
      status: 'delivered', sent_at: Date.now(),
      delivered_payload: 'Here is the translation...',
    }];
    const { getByText } = wrap(<InboxScreen />);
    fireEvent.press(getByText('ACTIVE'));
    expect(getByText('Pay & Accept')).toBeTruthy();
  });
});
