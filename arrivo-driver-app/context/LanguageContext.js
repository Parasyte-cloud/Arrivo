import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LANGUAGES, TRANSLATIONS } from "../i18n/translations";
import { translate, pickLanguage } from "../i18n/i18n";

// Language for the translated screens. Starts from the phone's language when
// we support it (English otherwise), and remembers an explicit choice.

const STORAGE_KEY = "arrivo_driver_language";
const SUPPORTED = LANGUAGES.map((l) => l.code);
const LanguageContext = createContext(null);

function deviceLanguage() {
  try {
    return pickLanguage(Intl.DateTimeFormat().resolvedOptions().locale, SUPPORTED);
  } catch (e) {
    return "en";
  }
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(deviceLanguage());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => { if (saved && SUPPORTED.includes(saved)) setLangState(saved); })
      .catch(() => {});
  }, []);

  const setLang = useCallback((code) => {
    if (!SUPPORTED.includes(code)) return;
    setLangState(code);
    AsyncStorage.setItem(STORAGE_KEY, code).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ lang, setLang, t: (key, params) => translate(TRANSLATIONS, lang, key, params) }),
    [lang, setLang]
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useT must be used inside LanguageProvider");
  return ctx;
}
