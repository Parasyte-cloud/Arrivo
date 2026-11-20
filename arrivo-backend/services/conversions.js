"use strict";
/*
 * Server-side conversion events: Meta Conversions API and TikTok Events API.
 *
 * Why: browser pixels miss people with ad blockers and iPhone privacy limits.
 * The website sends the same event from the browser with the same event id, and
 * Meta/TikTok use that id to count it once.
 *
 * Rules this file enforces:
 *  - Only when the website says the visitor said yes (marketing.consent === true)
 *    and no Global Privacy Control header is present. Mobile apps send no
 *    `marketing` block, so they never produce an event.
 *  - Only for new rider accounts, once, at signup.
 *  - Data minimised: hashed email, hashed phone, hashed user id, IP, browser
 *    string, and the ad platforms' own browser ids. No name, no address.
 *  - Never blocks or fails signup. Errors are logged without any payload.
 * Secrets come from environment variables only (see .env.example).
 */
const crypto = require("crypto");

const TIMEOUT_MS = 4000;

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const normEmail = (v) => String(v || "").trim().toLowerCase();
const normPhoneDigits = (v) => String(v || "").replace(/\D/g, "");

function settings(env = process.env) {
  const on = String(env.CONVERSIONS_ENABLED || "true").toLowerCase() !== "false";
  return {
    meta: on && env.META_PIXEL_ID && env.META_CAPI_TOKEN
      ? { pixelId: env.META_PIXEL_ID, token: env.META_CAPI_TOKEN, version: env.META_GRAPH_VERSION || "v21.0", testCode: env.META_TEST_EVENT_CODE || "" }
      : null,
    tiktok: on && env.TIKTOK_PIXEL_CODE && env.TIKTOK_EVENTS_TOKEN
      ? { pixelCode: env.TIKTOK_PIXEL_CODE, token: env.TIKTOK_EVENTS_TOKEN, testCode: env.TIKTOK_TEST_EVENT_CODE || "" }
      : null,
  };
}

// The website's `marketing` block is untrusted input: every field is checked.
function cleanMarketing(raw) {
  if (!raw || typeof raw !== "object" || raw.consent !== true) return null;
  if (!/^[0-9a-f]{24}$/.test(String(raw.eventId || ""))) return null;
  const out = { eventId: raw.eventId };
  if (/^fb\.\d\.\d{10,14}\.\d{1,20}$/.test(String(raw.fbp || ""))) out.fbp = raw.fbp;
  if (/^fb\.\d\.\d{10,14}\.[A-Za-z0-9_-]{1,200}$/.test(String(raw.fbc || ""))) out.fbc = raw.fbc;
  if (/^[A-Za-z0-9._-]{1,120}$/.test(String(raw.ttp || ""))) out.ttp = raw.ttp;
  try {
    const u = new URL(String(raw.url || ""));
    const host = u.hostname;
    if (u.protocol === "https:" && (host === "ridearrivo.com" || host.endsWith(".ridearrivo.com"))) out.url = u.origin + u.pathname; // never the query or fragment
  } catch (e) { /* no page url */ }
  return out;
}

function metaBody(cfg, user, m, ctx, now) {
  const ud = { external_id: [sha256(user.id)] };
  if (user.email) ud.em = [sha256(normEmail(user.email))];
  const ph = normPhoneDigits(user.whatsapp_number || user.phone);
  if (ph.length >= 8) ud.ph = [sha256(ph)];
  if (ctx.ip) ud.client_ip_address = ctx.ip;
  if (ctx.userAgent) ud.client_user_agent = ctx.userAgent;
  if (m.fbp) ud.fbp = m.fbp;
  if (m.fbc) ud.fbc = m.fbc;
  const evt = { event_name: "CompleteRegistration", event_time: Math.floor(now / 1000), event_id: m.eventId, action_source: "website", user_data: ud };
  if (m.url) evt.event_source_url = m.url;
  const body = { data: [evt], access_token: cfg.token };
  if (cfg.testCode) body.test_event_code = cfg.testCode;
  return body;
}

function tiktokBody(cfg, user, m, ctx, now) {
  const u = { external_id: sha256(user.id) };
  if (user.email) u.email = sha256(normEmail(user.email));
  const ph = normPhoneDigits(user.whatsapp_number || user.phone);
  if (ph.length >= 8) u.phone = sha256("+" + ph);
  if (ctx.ip) u.ip = ctx.ip;
  if (ctx.userAgent) u.user_agent = ctx.userAgent;
  if (m.ttp) u.ttp = m.ttp;
  const evt = { event: "CompleteRegistration", event_time: Math.floor(now / 1000), event_id: m.eventId, user: u };
  if (m.url) evt.page = { url: m.url };
  const body = { event_source: "web", event_source_id: cfg.pixelCode, data: [evt] };
  if (cfg.testCode) body.test_event_code = cfg.testCode;
  return body;
}

async function post(fetchImpl, url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } finally { clearTimeout(timer); }
}

/**
 * emitRegistration({ user, marketing, ip, userAgent, gpc }) -> Promise<[{provider, ok, status}]>
 * Safe to call without awaiting. Never throws.
 */
async function emitRegistration({ user, marketing, ip, userAgent, gpc = false }, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    if (gpc || !user || !user.id || user.role !== "rider") return [];
    const m = cleanMarketing(marketing);
    if (!m) return [];
    const cfg = settings(env);
    const ctx = { ip: ip || "", userAgent: String(userAgent || "").slice(0, 400) };
    const jobs = [];
    if (cfg.meta) {
      const url = `https://graph.facebook.com/${cfg.meta.version}/${encodeURIComponent(cfg.meta.pixelId)}/events`;
      jobs.push(["meta", post(fetchImpl, url, {}, metaBody(cfg.meta, user, m, ctx, now))]);
    }
    if (cfg.tiktok) {
      jobs.push(["tiktok", post(fetchImpl, "https://business-api.tiktok.com/open_api/v1.3/event/track/", { "Access-Token": cfg.tiktok.token }, tiktokBody(cfg.tiktok, user, m, ctx, now))]);
    }
    const out = [];
    for (const [provider, p] of jobs) {
      try {
        const r = await p;
        let ok = r.ok;
        if (provider === "tiktok" && r.ok) { // TikTok answers 200 with a code in the body
          try { const j = await r.json(); ok = j && j.code === 0; } catch (e) { ok = false; }
        }
        if (!ok) console.error(`[conversions] ${provider} rejected the event (HTTP ${r.status})`);
        out.push({ provider, ok: !!ok, status: r.status });
      } catch (e) {
        console.error(`[conversions] ${provider} failed: ${e && e.name === "AbortError" ? "timeout" : "network error"}`);
        out.push({ provider, ok: false, status: 0 });
      }
    }
    return out;
  } catch (e) {
    console.error("[conversions] unexpected error");
    return [];
  }
}

module.exports = { emitRegistration, cleanMarketing, settings, sha256 };
