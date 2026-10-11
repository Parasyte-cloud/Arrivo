// Tests for which Apple audiences the server trusts (services/oauth.js
// getAppleClientIds). Hand-rolled runner, same convention as the other
// services/*.test.js files. Run directly with:
//   node services/oauth.test.js

const assert = require("assert");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error("FAIL: " + name);
    console.error(err);
    process.exit(1);
  }
}

// oauth.js reads the environment on every call, so each case sets exactly
// what it needs and the module is only loaded once.
const origWarn = console.warn;
console.warn = () => {};
delete process.env.APPLE_BUNDLE_IDS;
delete process.env.APPLE_ADDITIONAL_CLIENT_IDS;
const { getAppleClientIds, NATIVE_APPLE_CLIENT_IDS } = require("./oauth");
console.warn = origWarn;

const RIDER = "com.ridearrivo.rider";
const DRIVER = "com.ridearrivo.driver";

function withEnv(env, fn) {
  const saved = {
    APPLE_BUNDLE_IDS: process.env.APPLE_BUNDLE_IDS,
    APPLE_ADDITIONAL_CLIENT_IDS: process.env.APPLE_ADDITIONAL_CLIENT_IDS,
  };
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("native ids are the two iOS bundle identifiers", () => {
  assert.deepStrictEqual(NATIVE_APPLE_CLIENT_IDS, [RIDER, DRIVER]);
});

test("env unset: both native ids accepted", () => {
  assert.deepStrictEqual(withEnv({}, getAppleClientIds), [RIDER, DRIVER]);
});

test("env empty: both native ids accepted", () => {
  assert.deepStrictEqual(withEnv({ APPLE_ADDITIONAL_CLIENT_IDS: "" }, getAppleClientIds), [RIDER, DRIVER]);
});

test("rider and driver ids are accepted", () => {
  const ids = withEnv({}, getAppleClientIds);
  assert(ids.includes(RIDER));
  assert(ids.includes(DRIVER));
});

test("the Android package names in the legacy variable are NOT accepted", () => {
  const warn = console.warn;
  console.warn = () => {};
  const ids = withEnv({ APPLE_BUNDLE_IDS: "com.arrivo.app,com.arrivo.driver" }, getAppleClientIds);
  console.warn = warn;
  assert(!ids.includes("com.arrivo.app"));
  assert(!ids.includes("com.arrivo.driver"));
  assert.deepStrictEqual(ids, [RIDER, DRIVER]);
});

test("the legacy variable is ignored entirely, even with a valid-looking id", () => {
  const ids = withEnv({ APPLE_BUNDLE_IDS: "com.ridearrivo.web" }, getAppleClientIds);
  assert(!ids.includes("com.ridearrivo.web"));
});

test("an explicit Services id through APPLE_ADDITIONAL_CLIENT_IDS is accepted", () => {
  const ids = withEnv({ APPLE_ADDITIONAL_CLIENT_IDS: "com.ridearrivo.web" }, getAppleClientIds);
  assert.deepStrictEqual(ids, [RIDER, DRIVER, "com.ridearrivo.web"]);
});

test("a duplicate additional id is deduplicated", () => {
  const ids = withEnv({ APPLE_ADDITIONAL_CLIENT_IDS: "com.ridearrivo.web,com.ridearrivo.web," + RIDER }, getAppleClientIds);
  assert.deepStrictEqual(ids, [RIDER, DRIVER, "com.ridearrivo.web"]);
});

test("surrounding whitespace is trimmed", () => {
  const ids = withEnv({ APPLE_ADDITIONAL_CLIENT_IDS: "  com.ridearrivo.web  ,   " }, getAppleClientIds);
  assert.deepStrictEqual(ids, [RIDER, DRIVER, "com.ridearrivo.web"]);
});

test("an arbitrary audience is not in the accepted list", () => {
  const ids = withEnv({ APPLE_ADDITIONAL_CLIENT_IDS: "com.ridearrivo.web" }, getAppleClientIds);
  assert(!ids.includes("com.evil.app"));
  assert(!ids.includes(""));
});

test("a startup warning is logged when the legacy variable is still set", () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  const saved = process.env.APPLE_BUNDLE_IDS;
  process.env.APPLE_BUNDLE_IDS = "com.arrivo.app";
  delete require.cache[require.resolve("./oauth")];
  require("./oauth");
  if (saved === undefined) delete process.env.APPLE_BUNDLE_IDS;
  else process.env.APPLE_BUNDLE_IDS = saved;
  console.warn = warn;
  assert(warnings.some((w) => w.includes("APPLE_BUNDLE_IDS is deprecated")));
});

console.log("oauth.test.js: " + passed + " passed");
