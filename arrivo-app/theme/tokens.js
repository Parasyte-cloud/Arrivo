// Design tokens that follow ridearrivo.com exactly: the same light and dark palettes as the website
// (arrivo-ui.css), picked from the phone's own light/dark setting. The website's "liquid glass" is
// reproduced with translucent fills, a bright top edge and (in components/UI.js) a real blur.
//
// The palette is chosen once, when the app starts, because every StyleSheet in the app is built at
// that moment. So if someone flips their phone between light and dark while the app is open, the
// new look appears the next time the app is opened.
import { Appearance } from "react-native";

const LIGHT = {
  ink: "#0a1b33",
  inkSoft: "#14294a",
  bg: "#f4f6fa",
  primary: "#14407a",
  textMuted: "#56657c",
  amber: "#f5a300",
  amberText: "#7a4800",
  coral: "#C2362B",
  success: "#1F7A5C",
  glass: "rgba(255,255,255,0.62)",
  glassStrong: "rgba(255,255,255,0.80)",
  glassBorder: "rgba(255,255,255,0.70)",
  shine: "rgba(255,255,255,0.85)",
  line: "rgba(10,27,51,0.10)",
  lineStrong: "rgba(10,27,51,0.18)",
  tintRGB: "10,27,51",
  sheet: "#FFFFFF",
  fill: "#0a1b33",
  blurTint: "light",
};

const DARK = {
  ink: "#eef3fb",
  inkSoft: "#c5d3e8",
  bg: "#050c18",
  primary: "#7fb0f5",
  textMuted: "#9db0c9",
  amber: "#f5a300",
  amberText: "#ffc24d",
  coral: "#ff8a7d",
  success: "#5FD3A4",
  glass: "rgba(16,36,66,0.50)",
  glassStrong: "rgba(10,26,50,0.78)",
  glassBorder: "rgba(255,255,255,0.12)",
  shine: "rgba(255,255,255,0.12)",
  line: "rgba(255,255,255,0.10)",
  lineStrong: "rgba(255,255,255,0.20)",
  tintRGB: "255,255,255",
  sheet: "#0a1a32",
  fill: "#1b3a66",
  blurTint: "dark",
};

let scheme = "light";
try { scheme = Appearance.getColorScheme() === "dark" ? "dark" : "light"; } catch (e) { /* light */ }
export const isDark = scheme === "dark";
const P = isDark ? DARK : LIGHT;

// A faint wash of the ink colour (navy on light, white on dark) for fills, borders and dividers.
export const tint = (alpha) => `rgba(${P.tintRGB},${alpha})`;

export const colors = {
  ink: P.ink,
  inkSoft: P.inkSoft,
  bg: P.bg,
  surface: P.glass,
  surfaceBorder: P.glassBorder,
  cream: P.bg,            // alias kept for older screens
  textMuted: P.textMuted,
  amber: P.amber,
  amberText: P.amberText,
  teal: P.primary,        // the website has one blue, "primary"; older code still says teal
  tealBright: P.primary,
  primary: P.primary,
  coral: P.coral,
  success: P.success,
  fieldBg: tint(0.06),
  card: tint(0.04),
  cardBorder: P.line,
  glass: P.glass,
  glassStrong: P.glassStrong,
  glassBorder: P.glassBorder,
  shine: P.shine,
  line: P.line,
  lineStrong: P.lineStrong,
  sheet: P.sheet,         // solid surface for sheets, headers and the tab bar
  fill: P.fill,           // a dark solid that always carries white text (selected chips, camera screens)
  blurTint: P.blurTint,

  // Older screens still read colors.dark.*; it now holds the same palette.
  dark: {
    bg0: P.bg,
    bg1: P.sheet,
    glow: "transparent",
    glow2: "transparent",
    text: P.ink,
    textMuted: P.textMuted,
    surface: P.glass,
    surfaceBorder: P.glassBorder,
    surfaceHighlight: P.shine,
    hairline: P.line,
    fieldBg: tint(0.06),
  },
};

export const spacing = { xs: 6, sm: 10, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export const type = {
  title: { fontSize: 22, fontWeight: "700", color: colors.ink },
  subtitle: { fontSize: 13, color: colors.textMuted },
  body: { fontSize: 14, color: colors.ink },
  label: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
};
