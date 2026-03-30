module.exports = {
  preset: 'react-native',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-safe-area-context)/)',
  ],
  moduleNameMapper: {
    '@react-native-async-storage/async-storage': require.resolve(
      '@react-native-async-storage/async-storage/jest/async-storage-mock',
    ),
    'react-native-image-picker': require.resolve('./__mocks__/react-native-image-picker.js'),
    'react-native-keychain':     require.resolve('./__mocks__/react-native-keychain.js'),
    'react-native-localize':     require.resolve('./__mocks__/react-native-localize.js'),
  },
  setupFilesAfterEnv: ['./jest.setup.js'],
  testPathIgnorePatterns: ['/node_modules/', '/.claude/'],
};
