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
  useSolPrice: () => 150,
  useDexPrices: () => new Map([['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', { priceUsd: 1.0, symbol: 'USDC' }]]),
  useSkills: () => ({ skills: [], loading: false, reload: jest.fn() }),
  sweepSol: jest.fn().mockResolvedValue({ signature: 'abc', amount_sol: 0.5, amount_lamports: 500_000_000, destination: '9Abc' }),
}));
jest.mock('../../hooks/useAgentBrain', () => ({
  useAgentBrain: () => ({
    config: { minFeeUsdc: 1.0, minReputation: 50, capabilities: ['code'], provider: 'openai', autoAccept: true },
    loading: false, save: jest.fn(), reload: jest.fn(),
  }),
  PROVIDERS: [
    { key: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', hint: 'platform.openai.com' },
    { key: 'anthropic', label: 'Anthropic', model: 'claude-3-haiku', hint: 'console.anthropic.com' },
    { key: 'gemini', label: 'Gemini', model: 'gemini-2.0-flash', hint: 'aistudio.google.com' },
    { key: 'custom', label: 'Custom', model: '', hint: 'your provider' },
  ],
  ALL_CAPABILITIES: ['summarization', 'qa', 'translation', 'code_review', 'data_analysis'],
  saveLlmApiKey: jest.fn().mockResolvedValue(undefined),
  getLlmApiKey: jest.fn().mockResolvedValue(null),
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
jest.mock('../../i18n', () => ({
  setLanguage: jest.fn(),
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

describe('YouScreen — Brain tab', () => {
  it('shows Brain tab', () => {
    const { getByText } = wrap(<YouScreen />);
    fireEvent.press(getByText('Brain'));
    expect(getByText('Brain')).toBeTruthy();
  });
});

describe('YouScreen — Advanced tab', () => {
  it('renders Advanced tab content', () => {
    const { getByText } = wrap(<YouScreen />);
    fireEvent.press(getByText('Advanced'));
    expect(getByText('Advanced')).toBeTruthy();
  });
});
