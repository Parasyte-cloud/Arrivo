// Central design tokens — mirrors the Arrivo brand (navy / amber / teal)
// Keep every screen importing from here so the look stays consistent.

export const colors = {
  ink: "#12123B",
  inkSoft: "#1E1E4D",
  card: "rgba(255,255,255,0.05)",
  cardBorder: "rgba(255,255,255,0.09)",
  cream: "#F7F4EC",
  textMuted: "#9494BE",
  amber: "#F4A300",
  teal: "#0E7C7B",
  tealBright: "#5FE0DE",
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
