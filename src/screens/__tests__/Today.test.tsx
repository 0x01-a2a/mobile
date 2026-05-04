// src/screens/__tests__/Today.test.tsx
import React from 'react';
import { render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import TodayScreen from '../Today';

jest.mock('../../hooks/useNode', () => ({
  useNode: () => ({ status: 'running', config: { agentName: 'Aria' } }),
}));

jest.mock('../../hooks/useNodeApi', () => ({
  useTaskLog: () => ({
    entries: [
      { id: 1, timestamp: Math.floor(Date.now() / 1000), category: 'bounty', outcome: 'success', amount_usd: 1.70, duration_min: 5, summary: 'Code review', shared: false },
      { id: 2, timestamp: Math.floor(Date.now() / 1000) - 3600, category: 'bounty', outcome: 'success', amount_usd: 0.80, duration_min: 3, summary: 'Translation', shared: false },
    ],
    loading: false,
    reload: jest.fn(),
  }),
}));

function wrap(ui: React.ReactElement) {
  return render(<NavigationContainer>{ui}</NavigationContainer>);
}

describe('TodayScreen', () => {
  it('shows agent name', () => {
    const { getByText } = wrap(<TodayScreen />);
    expect(getByText('Aria')).toBeTruthy();
  });

  it('shows summed earned today', () => {
    const { getAllByText } = wrap(<TodayScreen />);
    expect(getAllByText('$2.50').length).toBeGreaterThanOrEqual(1);
  });

  it('shows recent job summaries', () => {
    const { getByText } = wrap(<TodayScreen />);
    expect(getByText('Code review')).toBeTruthy();
    expect(getByText('Translation')).toBeTruthy();
  });
});
