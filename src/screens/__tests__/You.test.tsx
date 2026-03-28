import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import YouScreen from '../You';

jest.mock('../../hooks/useNodeApi', () => ({
  useHotKeyBalance: () => ({
    tokens: [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: 12_400_000, decimals: 6 }],
    loading: false, solanaAddress: '7f3aBcDefg...', error: null,
  }),
  useTaskLog: () => ({ entries: [], loading: false, reload: jest.fn() }),
  sweepSol: jest.fn().mockResolvedValue({ signature: 'abc', amount_sol: 0.5, amount_lamports: 500_000_000, destination: '9Abc' }),
}));
jest.mock('../../hooks/useAgentBrain', () => ({
  useAgentBrain: () => ({
    config: { minFeeUsdc: 1.0, minReputation: 50, capabilities: ['code'], provider: 'openai', autoAccept: true },
    loading: false, save: jest.fn(), reload: jest.fn(),
  }),
}));
jest.mock('../../hooks/useNode', () => ({
  useNode: () => ({ status: 'running', config: { agentName: 'Aria' } }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn(),
}));
jest.mock('../../../App', () => ({
  useSignOut: () => jest.fn(),
}));

function wrap(ui: React.ReactElement) {
  return render(<NavigationContainer>{ui}</NavigationContainer>);
}

describe('YouScreen — Wallet tab', () => {
  it('shows USDC balance', () => {
    const { getByText } = wrap(<YouScreen />);
    expect(getByText('$12.40')).toBeTruthy();
  });

  it('shows "No transactions yet" when history is empty', () => {
    const { getByText } = wrap(<YouScreen />);
    expect(getByText('No transactions yet')).toBeTruthy();
  });
});

describe('YouScreen — Agent tab', () => {
  it('shows agent name on Agent tab', () => {
    const { getByText } = wrap(<YouScreen />);
    fireEvent.press(getByText('Agent'));
    expect(getByText('Aria')).toBeTruthy();
  });
});

describe('YouScreen — Settings tab', () => {
  it('renders Settings tab content', () => {
    const { getByText } = wrap(<YouScreen />);
    fireEvent.press(getByText('Settings'));
    expect(getByText('Auto-start on boot')).toBeTruthy();
  });
});
