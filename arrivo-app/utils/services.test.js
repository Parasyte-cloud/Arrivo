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
const calls = [];
const nav = { navigate: (...a) => calls.push(["navigate", ...a]), replace: (...a) => calls.push(["replace", ...a]) };
m.goToService(nav, "boat"); m.goToService(nav, "ride", { replace: true }); m.goToService(nav, "nope");
assert.deepStrictEqual(calls, [["navigate", "ServiceRequest", { service: "boat" }], ["replace", "Route", undefined]]);
console.log("services ok");
