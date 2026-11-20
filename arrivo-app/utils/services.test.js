// Run directly: node utils/services.test.js
// Every rider can use every service; only drivers are limited by tier.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "services.js"), "utf8");
const m = new Function(src.replace(/^export (const|function) /gm, "$1 ") + "\nreturn { SERVICES, REQUEST_SERVICES, isRequestService, goToService };")();
const driverTiers = fs.readFileSync(path.join(__dirname, "../../arrivo-driver-app/utils/tiers.js"), "utf8").match(/TIER_ORDER = \[([^\]]*)\]/)[1].replace(/["\s]/g, "").split(",");
assert.deepStrictEqual(m.SERVICES.map((s) => s.id), driverTiers, "the rider can order exactly the services a driver can be granted");
assert.deepStrictEqual(m.REQUEST_SERVICES, ["campus", "air", "boat", "removals"]);
assert.strictEqual(m.SERVICES.find((s) => s.id === "campus").screen, "Campus", "Campus opens the map-first screen, like the web");
const calls = [];
const nav = { navigate: (...a) => calls.push(["navigate", ...a]), replace: (...a) => calls.push(["replace", ...a]) };
m.goToService(nav, "boat"); m.goToService(nav, "ride", { replace: true }); m.goToService(nav, "nope");
assert.deepStrictEqual(calls, [["navigate", "ServiceRequest", { service: "boat" }], ["replace", "Route", undefined]]);
// The home card for Campus opens the map screen with what the rider already typed; the other request services keep their form.
const hub = new Function(src.replace(/^export (const|function) /gm, "$1 ") + "\nreturn { openHubCard };")();
const c2 = [];
const n2 = { navigate: (...a) => c2.push(a) };
hub.openHubCard(n2, { flow: "request", service: "campus" }, { pickup: { address: "A", lat: 1, lng: 2 } });
hub.openHubCard(n2, { flow: "request", service: "boat" }, {});
assert.strictEqual(c2[0][0], "Campus");
assert.strictEqual(c2[0][1].prefill.pickup.address, "A");
assert.strictEqual(c2[1][0], "ServiceRequest");
console.log("services ok");
