// App version awareness, so a build that is too old can be told to update
// instead of failing in confusing ways later.
//
// How it works: the rider and driver apps send three headers on every request
//   X-App-Name      rider | driver
//   X-App-Version   the app's own version, e.g. 1.0.0
//   X-App-Platform  ios | android
// If a minimum version is configured for that app and the sent version is
// below it, the API answers 426 with code "app_update_required" and the app
// shows a screen that sends the rider to the store.
//
// The hard limit, and why this is built the way it is: builds already on
// phones send NO headers, and there is no over-the-air update to change them.
// So a request without the headers is never blocked here. It is simply an
// "unversioned" client (req.appClient.known === false). That is useful on its
// own: a route can later choose to refuse unversioned clients once most users
// have moved to a build that sends the headers, which is the way to enforce
// things like a token on payment initialize without breaking everyone at once.
//
// Configuration (all optional; with nothing set, nothing is ever blocked):
//   MIN_APP_VERSION_RIDER, MIN_APP_VERSION_DRIVER    e.g. 1.2.0
//   STORE_URL_RIDER_IOS, STORE_URL_RIDER_ANDROID     store page for the update button
//   STORE_URL_DRIVER_IOS, STORE_URL_DRIVER_ANDROID
//   APP_VERSION_GATE_MODE   "enforce" (default) or "log" (only logs who would
//                           have been blocked, for a safe first rollout)

const APPS = ["rider", "driver"];
const PLATFORMS = ["ios", "android"];

// Play Store pages follow from the package names in each app.json, so Android
// works without configuration. The App Store link needs the numeric app id,
// which is not in the repo, so iOS stays null until STORE_URL_*_IOS is set.
const DEFAULT_STORE_URLS = {
  rider: { android: "https://play.google.com/store/apps/details?id=com.arrivo.app" },
  driver: { android: "https://play.google.com/store/apps/details?id=com.arrivo.driver" },
};

// "1.2.3" -> [1, 2, 3]. "1.2" -> [1, 2, 0]. "1.2.3-beta.4" -> [1, 2, 3].
// Anything that does not start with a number gives null.
function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = /^\s*(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?![\d.]*\d)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

// -1, 0 or 1. Both arguments must already be parsed.
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function headerValue(headers, name) {
  const value = headers && headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// What the caller says about itself. known is true only when the app name and a
// readable version are both present.
function readClient(headers) {
  const app = String(headerValue(headers, "x-app-name") || "").trim().toLowerCase();
  const platform = String(headerValue(headers, "x-app-platform") || "").trim().toLowerCase();
  const versionText = String(headerValue(headers, "x-app-version") || "").trim();
  const parsed = parseVersion(versionText);
  const appOk = APPS.includes(app);
  return {
    app: appOk ? app : null,
    platform: PLATFORMS.includes(platform) ? platform : null,
    version: parsed ? versionText.slice(0, 32) : null,
    parsedVersion: parsed,
    known: appOk && !!parsed,
  };
}

function minVersionFor(app, env) {
  if (!app) return null;
  const text = env[`MIN_APP_VERSION_${app.toUpperCase()}`];
  return parseVersion(text) ? String(text).trim() : null;
}

function storeUrlFor(app, platform, env) {
  if (!app || !platform) return null;
  const configured = env[`STORE_URL_${app.toUpperCase()}_${platform.toUpperCase()}`];
  if (configured && /^https:\/\//.test(configured.trim())) return configured.trim();
  return (DEFAULT_STORE_URLS[app] && DEFAULT_STORE_URLS[app][platform]) || null;
}

// { status: "ok" } or { status: "update_required", minVersion, storeUrl }
function evaluateClient(client, env = process.env) {
  if (!client || !client.known) return { status: "ok" };
  const minVersion = minVersionFor(client.app, env);
  if (!minVersion) return { status: "ok" };
  if (compareVersions(client.parsedVersion, parseVersion(minVersion)) >= 0) return { status: "ok" };
  return { status: "update_required", minVersion, storeUrl: storeUrlFor(client.app, client.platform, env) };
}

// Paths that must keep working for an out-of-date app: the config endpoint
// (it carries the update details) and the service root used for health checks.
function isExempt(path) {
  return path === "/" || path === "/api/config" || path.startsWith("/api/config/");
}

function appVersionGate(env = process.env) {
  return function gate(req, res, next) {
    const client = readClient(req.headers);
    req.appClient = client;
    if (isExempt(req.path)) return next();
    const verdict = evaluateClient(client, env);
    if (verdict.status !== "update_required") return next();
    if (String(env.APP_VERSION_GATE_MODE || "enforce").toLowerCase() === "log") {
      console.warn(`[app-version] would block ${client.app} ${client.version} (${client.platform || "?"}), min ${verdict.minVersion}: ${req.method} ${req.path}`);
      return next();
    }
    return res.status(426).json({
      error: "Please update the RideArrivo app to keep going.",
      code: "app_update_required",
      minVersion: verdict.minVersion,
      storeUrl: verdict.storeUrl,
    });
  };
}

module.exports = { parseVersion, compareVersions, readClient, evaluateClient, appVersionGate, minVersionFor, storeUrlFor, isExempt };
