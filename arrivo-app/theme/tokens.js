// Central design tokens — mirrors the RideArrivo brand (navy / amber)
// Keep every screen importing from here so the look stays consistent.

export const colors = {
  ink: "#12123B",
  inkSoft: "#1E1E4D",
  card: "rgba(255,255,255,0.05)",
  cardBorder: "rgba(255,255,255,0.09)",
  cream: "#F7F4EC",
  textMuted: "#9494BE",
  amber: "#F4A300",
  // The website dropped teal entirely in favor of a navy/amber two-color
  // system (see ridearrivo-website/styles.css --primary). Repointing the
  // *values* here rather than renaming the keys, since teal/tealBright are
  // referenced in ~23 places across both apps and there's no way for me to
  // visually verify a React Native screen renders correctly after a rename
  // — no simulator or device available in this environment, unlike the
  // website where every change was tested in a real browser.
  teal: "#2E4C8C",
  tealBright: "#5B7FC7",
  coral: "#E1523D",
  fieldBg: "rgba(255,255,255,0.06)",
};

export const spacing = { xs: 6, sm: 10, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export const type = {
  title: { fontSize: 22, fontWeight: "700", color: colors.cream },
  subtitle: { fontSize: 13, color: colors.textMuted },
  body: { fontSize: 14, color: colors.cream },
  label: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
};
