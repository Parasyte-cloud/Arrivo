// Tests for the app version gate. Run directly:
//   node services/appVersion.test.js

const assert = require("assert");
const { parseVersion, compareVersions, readClient, evaluateClient, appVersionGate, isExempt } = require("./appVersion");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const hdr = (app, version, platform = "android") => ({ "x-app-name": app, "x-app-version": version, "x-app-platform": platform });

// Drives the middleware with a fake request and response.
function run(headers, env, path = "/api/rides", method = "GET") {
  const out = { nextCalled: false, status: null, body: null };
  const req = { headers, path, method };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  appVersionGate(env)(req, res, () => { out.nextCalled = true; });
  out.req = req;
  return out;
}

console.log("Version parsing:");
test("parses full, short and suffixed versions", () => {
  assert.deepStrictEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepStrictEqual(parseVersion("1.2"), [1, 2, 0]);
  assert.deepStrictEqual(parseVersion("7"), [7, 0, 0]);
  assert.deepStrictEqual(parseVersion(" 2.0.1 "), [2, 0, 1]);
});
test("rejects things that are not versions", () => {
  for (const bad of [undefined, null, "", "abc", "v1.2.3", "1.2.3.4", "-1.0.0", 5, {}]) {
    assert.strictEqual(parseVersion(bad), null, JSON.stringify(bad));
  }
});
test("compares numerically, not as text", () => {
  assert.strictEqual(compareVersions([1, 10, 0], [1, 9, 0]), 1);
  assert.strictEqual(compareVersions([1, 2, 3], [1, 2, 3]), 0);
  assert.strictEqual(compareVersions([0, 9, 9], [1, 0, 0]), -1);
  assert.strictEqual(compareVersions([2, 0, 0], [10, 0, 0]), -1);
});

console.log("\nReading the client:");
test("a full set of headers is a known client", () => {
  const c = readClient(hdr("Rider", "1.4.0", "iOS"));
  assert.strictEqual(c.known, true);
  assert.strictEqual(c.app, "rider");
  assert.strictEqual(c.platform, "ios");
  assert.strictEqual(c.version, "1.4.0");
});
test("missing, partial or odd headers make an unversioned client", () => {
  assert.strictEqual(readClient({}).known, false);
  assert.strictEqual(readClient(undefined).known, false);
  assert.strictEqual(readClient({ "x-app-version": "1.0.0" }).known, false);
  assert.strictEqual(readClient(hdr("rider", "latest")).known, false);
  assert.strictEqual(readClient(hdr("website", "1.0.0")).known, false);
  assert.strictEqual(readClient(hdr("rider", "1.0.0", "toaster")).platform, null);
});

console.log("\nDeciding:");
test("nothing configured blocks nobody", () => {
  assert.strictEqual(evaluateClient(readClient(hdr("rider", "0.0.1")), {}).status, "ok");
});
test("a build below the minimum must update, with the store link", () => {
  const v = evaluateClient(readClient(hdr("rider", "1.0.0")), { MIN_APP_VERSION_RIDER: "1.2.0" });
  assert.strictEqual(v.status, "update_required");
  assert.strictEqual(v.minVersion, "1.2.0");
  assert.ok(v.storeUrl.includes("com.arrivo.app"));
});
test("the minimum itself and anything above is fine", () => {
  const env = { MIN_APP_VERSION_RIDER: "1.2.0" };
  assert.strictEqual(evaluateClient(readClient(hdr("rider", "1.2.0")), env).status, "ok");
  assert.strictEqual(evaluateClient(readClient(hdr("rider", "1.10.0")), env).status, "ok");
});
test("rider and driver minimums are separate", () => {
  const env = { MIN_APP_VERSION_RIDER: "2.0.0" };
  assert.strictEqual(evaluateClient(readClient(hdr("driver", "1.0.0")), env).status, "ok");
});
test("an invalid configured minimum is ignored rather than blocking everyone", () => {
  assert.strictEqual(evaluateClient(readClient(hdr("rider", "1.0.0")), { MIN_APP_VERSION_RIDER: "soon" }).status, "ok");
});
test("iOS has no store link until one is configured, and only https links are accepted", () => {
  const base = { MIN_APP_VERSION_RIDER: "2.0.0" };
  assert.strictEqual(evaluateClient(readClient(hdr("rider", "1.0.0", "ios")), base).storeUrl, null);
  const ok = evaluateClient(readClient(hdr("rider", "1.0.0", "ios")), { ...base, STORE_URL_RIDER_IOS: "https://apps.apple.com/app/id1" });
  assert.strictEqual(ok.storeUrl, "https://apps.apple.com/app/id1");
  const bad = evaluateClient(readClient(hdr("rider", "1.0.0", "ios")), { ...base, STORE_URL_RIDER_IOS: "javascript:alert(1)" });
  assert.strictEqual(bad.storeUrl, null);
});

console.log("\nMiddleware:");
test("an old build with no headers is never blocked, even with a minimum set", () => {
  const r = run({}, { MIN_APP_VERSION_RIDER: "9.0.0" });
  assert.ok(r.nextCalled && r.status === null);
  assert.strictEqual(r.req.appClient.known, false);
});
test("a known old build gets 426 with the update details", () => {
  const r = run(hdr("rider", "1.0.0"), { MIN_APP_VERSION_RIDER: "1.2.0" });
  assert.strictEqual(r.nextCalled, false);
  assert.strictEqual(r.status, 426);
  assert.strictEqual(r.body.code, "app_update_required");
  assert.strictEqual(r.body.minVersion, "1.2.0");
});
test("a current build passes and carries its identity on the request", () => {
  const r = run(hdr("driver", "3.0.0"), { MIN_APP_VERSION_DRIVER: "2.0.0" });
  assert.ok(r.nextCalled);
  assert.strictEqual(r.req.appClient.app, "driver");
});
test("log mode lets the request through", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = run(hdr("rider", "1.0.0"), { MIN_APP_VERSION_RIDER: "1.2.0", APP_VERSION_GATE_MODE: "log" });
    assert.ok(r.nextCalled && r.status === null);
  } finally {
    console.warn = warn;
  }
});
test("the config endpoint and health root are never blocked", () => {
  const env = { MIN_APP_VERSION_RIDER: "9.0.0" };
  assert.ok(run(hdr("rider", "1.0.0"), env, "/api/config/booking").nextCalled);
  assert.ok(run(hdr("rider", "1.0.0"), env, "/").nextCalled);
  assert.strictEqual(isExempt("/api/configuration"), false);
  assert.strictEqual(run(hdr("rider", "1.0.0"), env, "/api/auth/login", "POST").status, 426);
});

console.log(`\n${passed} passed`);
