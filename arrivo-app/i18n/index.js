import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import * as Localization from "expo-localization";

// Hermes (React Native's default JS engine) doesn't always ship a full
// Intl.PluralRules implementation, which i18next needs to pick correct
// plural forms per language. Without this polyfill, i18next logs a
// warning on startup and falls back to a less accurate default —
// harmless for simple strings, but worth closing properly rather than
// leaving a startup warning visible on every launch.
if (!Intl.PluralRules) {
  require("@formatjs/intl-pluralrules/polyfill");
  require("@formatjs/intl-pluralrules/locale-data/en");
  require("@formatjs/intl-pluralrules/locale-data/fr");
}

import en from "./locales/en.json";
import fr from "./locales/fr.json";

const supportedLanguages = ["en", "fr"];

function detectDeviceLanguage() {
  const deviceLang = Localization.getLocales()?.[0]?.languageCode;
  return supportedLanguages.includes(deviceLang) ? deviceLang : "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
  },
  lng: detectDeviceLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// Call this once you know the signed-in user's saved preference
// (e.g. after login, or after loading it from storage).
export function setAppLanguage(lang) {
  if (supportedLanguages.includes(lang)) {
    i18n.changeLanguage(lang);
  }
}

export { supportedLanguages };
export default i18n;
