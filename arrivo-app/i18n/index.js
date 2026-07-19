import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import * as Localization from "expo-localization";

// A polyfill for Intl.PluralRules was here for SDK 51, where Hermes didn't
// always ship full support and i18next would log a startup warning
// without it. SDK 54's Hermes engine has native Intl.PluralRules support,
// which makes the polyfill unnecessary — and its own internal capability
// check actively crashes when run against this newer engine, so it's
// removed rather than conditionally skipped. If a future SDK regresses
// this, the fix is re-adding a version of the polyfill that's actually
// compatible with whatever Hermes is running at the time, not just
// restoring this exact code.

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
  // Uses i18next's own built-in pluralization logic instead of the
  // Intl.PluralRules API. This sidesteps needing Intl.PluralRules to be
  // present at all — natively or via a polyfill — which is what caused
  // both the original startup warning on SDK 51 and the later crash from
  // a polyfill package that didn't handle SDK 54's engine correctly. For
  // English and French with straightforward plural forms, this built-in
  // handling is fully sufficient and removes this entire category of
  // engine-version dependency going forward.
  compatibilityJSON: "v3",
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
