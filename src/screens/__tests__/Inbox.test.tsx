import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import InboxScreen from '../Inbox';

// Build a properly encoded payload (16-byte amount + JSON body)
function makePayload(amountMicro: number, message: string): string {
  const json = JSON.stringify({ message, round: 0 });
  const jsonBytes = Array.from(json).map((c: string) => c.charCodeAt(0));
  const full = new Uint8Array(16 + jsonBytes.length);
  // Write amount as LE uint32 (sufficient for test values < 4B)
  full[0] = amountMicro & 0xff;
  full[1] = (amountMicro >> 8) & 0xff;
  full[2] = (amountMicro >> 16) & 0xff;
  full[3] = (amountMicro >> 24) & 0xff;
  for (let i = 0; i < jsonBytes.length; i++) full[16 + i] = jsonBytes[i];
  return btoa(String.fromCharCode(...Array.from(full)));
}

let capturedCallback: ((env: any) => void) | null = null;

// jest.mock is hoisted, so reference module mock state via require inside factory
jest.mock('../../hooks/useNodeApi', () => {
  const actual = jest.requireActual('../../hooks/useNodeApi');
  return {
    useInbox: (cb: any) => {
      capturedCallback = cb;
      return { authError: false };
    },
    sendEnvelope: jest.fn().mockResolvedValue(true),
    decodeBidPayload: actual.decodeBidPayload,
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

describe('InboxScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;
  });

  it('shows "No new jobs" when empty', () => {
    const { getByText } = wrap(<InboxScreen />);
    expect(getByText('No new jobs')).toBeTruthy();
  });

  it('shows job card when envelope arrives', async () => {
    const { getByText } = wrap(<InboxScreen />);
    await act(async () => {
      capturedCallback?.(mockEnvelope);
    });
    expect(getByText('Review Rust code')).toBeTruthy();
    expect(getByText('$2.50')).toBeTruthy();
  });

  it('calls sendEnvelope ACCEPT when job is accepted', async () => {
    // Import the mocked module to access the mock fn
    const { sendEnvelope } = require('../../hooks/useNodeApi');

    const { getByText } = wrap(<InboxScreen />);
    await act(async () => { capturedCallback?.(mockEnvelope); });
    // Tap to expand (description appears in card title)
    fireEvent.press(getByText('Review Rust code'));
    // Tap accept button (text is "Accept · $2.50")
    await act(async () => { fireEvent.press(getByText(/Accept/)); });
    await waitFor(() => {
      expect(sendEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ msg_type: 'ACCEPT', conversation_id: 'conv-1' })
      );
    });
  });
});
