// Guards the two defects that broke Sign in with Apple / Google in review.
// Source-level on purpose: these files import React Native and cannot be
// loaded in plain node. PArAsYtE
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok -", name); };

for (const app of ["arrivo-app", "arrivo-driver-app"]) {
  const buttons = read(`${app}/components/OAuthButtons.js`);
  const signup = read(`${app}/screens/SignupScreen.js`);

  ok(`${app}: no dead buttons (never disabled, never onPress undefined)`, () => {
    assert(!/disabled=\{disabled \|\| !request\}/.test(buttons));
    assert(!/onPress=\{disabled \? undefined/.test(buttons));
    assert(/onBlocked/.test(buttons));
  });
  ok(`${app}: Google iOS redirect is the documented reversed-client-id form`, () => {
    assert(/redirectUri: `\$\{GOOGLE_IOS_URL_SCHEME\}:\/oauthredirect`/.test(buttons));
  });
  ok(`${app}: signup tells the person why a tap was blocked`, () => {
    assert(/onBlocked=\{/.test(signup));
  });
}

ok("driver app forwards authorizationCode to the backend", () => {
  assert(/loginWithApple\(\{ identityToken, fullName, agreedToTerms, authorizationCode \}\)/.test(read("arrivo-driver-app/context/AuthContext.js")));
  const api = read("arrivo-driver-app/services/api.js");
  assert(/export function loginWithApple\(\{[^}]*authorizationCode/.test(api));
  assert(/role: "driver", agreedToTerms, authorizationCode/.test(api));
});

console.log(`${n} passed`);
