// Pure translation helpers (no imports, loadable from a node test).

// translations: the TRANSLATIONS object. Falls back to English, then to the key.
export function translate(translations, lang, key, params) {
  const table = translations[lang] || {};
  let text = table[key];
  if (text === undefined) text = (translations.en || {})[key];
  if (text === undefined) return key;
  if (params) {
    text = text.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? String(params[name]) : m));
  }
  return text;
}

// "fr-NG" or "zh_Hans_CN" -> "fr" / "zh" when we have it, else "en".
export function pickLanguage(locale, supported) {
  const base = String(locale || "").toLowerCase().split(/[-_]/)[0];
  return supported.includes(base) ? base : "en";
}

// "₦1,500" style thousands separators that do not depend on the device's Intl.
export function formatNumber(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
