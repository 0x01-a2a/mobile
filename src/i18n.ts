import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { findBestLanguageTag } from 'react-native-localize';
import AsyncStorage from '@react-native-async-storage/async-storage';

import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

const LANG_KEY = 'zerox1:language';

const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN },
};

export async function initI18n() {
  let savedLang: string | null = null;
  try { savedLang = await AsyncStorage.getItem(LANG_KEY); } catch {}

  const deviceLang = findBestLanguageTag(Object.keys(resources))?.languageTag ?? 'en';
  const lng = savedLang ?? deviceLang;

  await i18n.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
}

export async function setLanguage(lang: string) {
  await AsyncStorage.setItem(LANG_KEY, lang);
  await i18n.changeLanguage(lang);
}

export { i18n };
