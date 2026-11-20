// Run directly: node utils/mapFirst.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "mapFirst.js"), "utf8");
const m = new Function(src.replace(/^export (const|function) /gm, "$1 ") + "\nreturn { placeOf, swapPlaces, isResolved, routePresets, applySchool, flipDirection, firstPrediction, CAMPUS_SCHOOLS };")();

const a = { address: "Ikeja City Mall", lat: 6.61, lng: 3.35 };
const b = { address: "Lekki Phase 1", lat: 6.45, lng: 3.47 };
const school = { address: "University of Lagos", lat: 6.5189, lng: 3.3987 };

assert.strictEqual(m.placeOf("", null), null);
assert.deepStrictEqual(m.placeOf(" Yaba ", null), { address: "Yaba", lat: null, lng: null });
assert.deepStrictEqual(m.swapPlaces(a, b), { pickup: b, destination: a });
assert.deepStrictEqual(m.swapPlaces(a, null), { pickup: null, destination: a }, "swapping with an empty end keeps the filled one");
assert.strictEqual(m.isResolved(a), true);
assert.strictEqual(m.isResolved({ address: "typed only", lat: null, lng: null }), false, "typed text with no map point cannot be quoted");
assert.strictEqual(m.isResolved(null), false);

// Schedule hands the same trip to the booking screen.
assert.deepStrictEqual(m.routePresets(a, b), {
  presetPickupAddress: "Ikeja City Mall", presetPickupLat: 6.61, presetPickupLng: 3.35,
  presetDestinationAddress: "Lekki Phase 1", presetDestinationLat: 6.45, presetDestinationLng: 3.47,
});
assert.strictEqual(m.routePresets(null, null).presetPickupAddress, undefined);
assert.strictEqual(m.routePresets({ address: "typed only", lat: null, lng: null }, null).presetPickupLat, undefined, "typed text carries no fake point");

// Campus direction.
assert.deepStrictEqual(m.applySchool("to", { pickup: a, destination: null }, school), { pickup: a, destination: school });
assert.deepStrictEqual(m.applySchool("from", { pickup: null, destination: b }, school), { pickup: school, destination: b });
const flipped = m.flipDirection("to", { pickup: a, destination: school });
assert.deepStrictEqual(flipped, { direction: "from", pickup: school, destination: a }, "the school moves to the pickup when coming home");
assert.strictEqual(m.flipDirection("from", flipped).direction, "to");

assert.strictEqual(m.firstPrediction([]), null);
assert.strictEqual(m.firstPrediction(null), null);
assert.strictEqual(m.firstPrediction([{ description: "x" }]), null, "a suggestion with no placeId cannot be resolved");
assert.strictEqual(m.firstPrediction([{ placeId: "p1" }, { placeId: "p2" }]).placeId, "p1");

// The shortcut list matches the web's.
assert.deepStrictEqual(m.CAMPUS_SCHOOLS.map((s) => s.label), ["UNILAG main gate", "LASU, Ojo", "Yabatech", "Covenant University", "Babcock University"]);
assert.ok(!/—/.test(src), "no em dash");
console.log("mapFirst ok");
