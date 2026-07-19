// Central design tokens — mirrors the RideArrivo website's actual light
// theme (cream background, navy ink text, amber accent) rather than the
// dark theme this app previously used. Real Liquid Glass blur is provided
// by expo-blur in components/UI.js, using these surface/border values.

export const colors = {
  ink: "#12123B",        // primary dark navy — headings, primary text
  inkSoft: "#2E4C8C",     // lighter navy — secondary accents, links
  bg: "#F7F4EC",          // the website's cream page background
  surface: "rgba(255,255,255,0.55)", // translucent white glass card fill, sits over BlurView
  surfaceBorder: "rgba(255,255,255,0.6)",
  cream: "#F7F4EC",       // kept as an alias for bg — some screens may still reference colors.cream directly
  textMuted: "#6B6B94",   // muted navy-gray, readable on the light background (old value was tuned for dark bg and is too low-contrast here)
  amber: "#F4A300",
  teal: "#2E4C8C",        // repointed to navy — the website dropped a separate teal accent in favor of navy/amber
  tealBright: "#5B7FC7",
  coral: "#E1523D",
  fieldBg: "rgba(18,18,59,0.05)", // subtle dark tint for input fields on a light background
};

export const spacing = { xs: 6, sm: 10, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };

export const type = {
  title: { fontSize: 22, fontWeight: "700", color: colors.ink },
  subtitle: { fontSize: 13, color: colors.textMuted },
  body: { fontSize: 14, color: colors.ink },
  label: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
};
