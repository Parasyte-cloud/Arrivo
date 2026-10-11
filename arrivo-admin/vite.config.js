import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  // src/api.js falls back to http://localhost:4000 when this is unset. That is
  // right for `vite dev` and wrong for a deployed build, which would ship an
  // admin panel that talks to localhost. Fail the build instead.
  // loadEnv reads .env, .env.production and the real environment. Vite does not
  // put the .env files on process.env, so checking process.env alone would fail
  // a correctly configured local build.
  const env = loadEnv(mode, process.cwd(), "");
  if (mode === "production" && !env.VITE_API_BASE_URL) {
    throw new Error("VITE_API_BASE_URL must be set for a production build (see .env.example).");
  }
  return {
  plugins: [
    react(),
    VitePWA({
      // Ship JS/CSS fixes to admins immediately on next load instead of
      // leaving them stuck on a stale cached build until they manually
      // reinstall — this is an internal ops tool, not a marketing site,
      // so "always latest" beats "offline-durable but possibly stale".
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        name: "RideArrivo Ops",
        short_name: "RideArrivo Ops",
        description:
          "Operations dashboard for RideArrivo — riders, drivers, rides, safety alerts, and live calling.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0d0d2e",
        theme_color: "#0d0d2e",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the built app shell (JS/CSS/HTML/icons) for fast/offline
        // loads. Deliberately no runtimeCaching entries for the backend API
        // origin — panic alerts, ride status, etc. must never be served
        // from cache, so API requests are left completely untouched by the
        // service worker and always hit the network.
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: {
        // Keep the SW out of `vite dev` — only build/preview register it,
        // so local development never fights a stale cached bundle.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
  },
};
});
