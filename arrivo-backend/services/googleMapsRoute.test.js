const test = require("node:test");
const assert = require("node:assert/strict");
const { decodePolyline, thinPath } = require("./googleMaps");

// The example from Google's polyline documentation.
test("decodes Google's documented example polyline", () => {
  const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  assert.deepEqual(pts, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test("a cut-off or empty string never throws", () => {
  assert.deepEqual(decodePolyline(""), []);
  assert.deepEqual(decodePolyline(undefined), []);
  assert.ok(Array.isArray(decodePolyline("_p~iF~ps|U_ul")));
});

test("thinning keeps both ends and the size limit", () => {
  const path = Array.from({ length: 1000 }, (_, k) => ({ lat: k, lng: k }));
  const out = thinPath(path, 100);
  assert.equal(out.length, 100);
  assert.deepEqual(out[0], path[0]);
  assert.deepEqual(out[99], path[999]);
  assert.equal(thinPath(path.slice(0, 5), 100).length, 5);
});
