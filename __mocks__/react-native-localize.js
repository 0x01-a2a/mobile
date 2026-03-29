// __mocks__/react-native-localize.js
module.exports = {
  getLocales: () => [{ languageCode: 'en', countryCode: 'US', languageTag: 'en-US', isRTL: false }],
  getNumberFormatSettings: () => ({ decimalSeparator: '.', groupingSeparator: ',' }),
  getCalendar: () => 'gregorian',
  getCountry: () => 'US',
  getCurrencies: () => ['USD'],
  getTemperatureUnit: () => 'celsius',
  getTimeZone: () => 'America/New_York',
  uses24HourClock: () => false,
  usesMetricSystem: () => true,
  findBestAvailableLanguage: () => ({ languageTag: 'en', isRTL: false }),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};
