// __mocks__/react-i18next.js
const en = require('../src/locales/en.json');

function lookup(obj, path) {
  return path.split('.').reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), obj);
}

function t(key, params) {
  let val = lookup(en, key);
  if (typeof val !== 'string') return key;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      val = val.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    });
  }
  return val;
}

const useTranslation = () => ({
  t,
  i18n: { language: 'en', changeLanguage: jest.fn().mockResolvedValue(undefined) },
});

module.exports = {
  useTranslation,
  Trans: ({ children }) => children,
  initReactI18next: { type: '3rdParty', init: jest.fn() },
  t,
};
