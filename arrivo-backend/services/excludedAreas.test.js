// Tests for the red-zone area check (services/fare.js findExcludedArea),
// which gates standard bookings, ArrivoExpress and deliveries. Every
// "serve" address below is a real Google Places address that the old
// substring match refused (e.g. "Lekki - Epe Expy" read as Epe). Run:
//   node services/excludedAreas.test.js

const assert = require("assert");
const { findExcludedArea } = require("./fare");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const serve = [
    "Lekki Conservation Centre, Lekki - Epe Expressway, Lekki, Nigeria",
    "Km 19 Lekki - Epe Expy, Lekki Penninsula II, Lekki 106104, Lagos, Nigeria",
    "Deeper Life Bible Church, Ajoke Salako St, Gbagada, Lagos, Nigeria",
    "First Season Hotel, Sikiru Adewale Road, Lekki - Epe Expressway, opposite Novare Mall ShopRite, Ajah/Sangotedo Sangotedo, Nigeria",
    "Blenco Supermarket, Lekki - Epe Expressway, Sangotedo Ajah/Sangotedo, Nigeria",
    "Lagos Business School, Lekki - Epe Expressway, Lagos, Nigeria",
    "Mega Chicken - Ikota, Lekki - Epe Expressway, Lekki, Nigeria",
    "Ikota Shopping Complex, Lekki - Epe Expy, Victoria garden City, Lekki 101245, Lagos, Nigeria",
    "Lagos State University Radio, Lagos - Badagry Express Way, Ojo, Lagos, Nigeria",
    "Trade Fair Complex, Off Badagry Expressway, Lagos - Badagry Expy, Lagos, Nigeria",
    "Plot 5, Lekki-Epe Expressway, Ajah, Lagos",
    "12 Admiralty Way, Lekki Phase 1, Lagos",
    "Independence Way, Ikeja, Lagos",
    "Murtala Muhammed International Airport, Ikeja, Lagos",
    "Festac Town, Lagos",
    "Mile 2, Badagry Road, Amuwo Odofin, Lagos",
    "", null,
];

const block = [
    ["Epe, Lagos, Nigeria", "Epe"],
    ["Epe 106101, Lagos, Nigeria", "Epe"],
    ["Km 60 Lekki-Epe Expressway, Epe, Lagos", "Epe"],
    ["Badagry 103101, Lagos, Nigeria", "Badagry"],
    ["Badagry Heritage Museum, Marina Rd, Badagry, Lagos", "Badagry"],
    ["Bamidele 56 lakowe ibeju lekki Lagos island, Lagos 105101, Lagos, Nigeria", "Ibeju-Lekki"],
    ["Dangote Refinery, Lekki Free Zone, Ibeju-Lekki, Lagos", "Ibeju-Lekki"],
    ["Makoko, Yaba, Lagos", "Makoko"],
    ["EPE", "Epe"],
];

for (const address of serve) {
  test(`serves: ${address}`, () => {
    const hit = findExcludedArea(address);
    assert.strictEqual(hit, null, `refused as ${hit && hit.name}`);
  });
}

for (const [address, name] of block) {
  test(`refuses ${name}: ${address}`, () => {
    const hit = findExcludedArea(address);
    assert.ok(hit, "was allowed");
    assert.strictEqual(hit.name, name);
  });
}

console.log(`${passed} passed`);
