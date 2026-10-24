// Run: node services/staffAccess.test.js   (no database needed)
const assert = require("assert");
const a = require("./staffAccess");
const { checkPermissionChange } = require("./staffAdmin");

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };

const admin = { id: 1, role: "admin" };
const support = { id: 2, role: "support" };
const ops = { id: 3, role: "operations" };
const owner = { id: 4, role: "admin", is_owner: true };

test("the display order lists every area exactly once", () => {
  assert.deepStrictEqual([...a.DISPLAY_ORDER].sort(), [...a.AREA_IDS].sort());
});

test("every area has a level in every preset", () => {
  for (const role of a.STAFF_ROLES) for (const id of a.AREA_IDS) assert.ok(a.LEVELS.includes(a.PRESETS[role][id]), `${role}/${id}`);
});

test("admins keep everything they had", () => {
  for (const id of a.AREA_IDS) assert.strictEqual(a.effectivePermissions(admin)[id], "manage");
  assert.ok(a.check(admin, "PATCH", "/api/admin/riders/5/wallet-adjust").ok);
});

test("operations keep exactly the pages they had, read only", () => {
  const p = a.effectivePermissions(ops);
  for (const id of ["ride-desk", "panics", "drivers", "rides", "flight-issues", "vehicles", "live-map", "analytics", "exports"]) assert.strictEqual(p[id], "view", id);
  for (const id of ["riders", "wallet", "support", "memberships", "arrivo-express", "express-pricing", "safety"]) assert.strictEqual(p[id], "none", id);
  assert.ok(a.check(ops, "GET", "/api/admin/drivers").ok);
  assert.ok(a.check(ops, "GET", "/api/admin/rides/live").ok);
  assert.ok(a.check(ops, "GET", "/api/rides/12/fleet").ok);
  assert.ok(!a.check(ops, "PATCH", "/api/admin/drivers/9/verify").ok);
  assert.ok(!a.check(ops, "GET", "/api/admin/riders").ok);
});

test("operations can still do their job on Ride Desk with view only", () => {
  assert.ok(a.check(ops, "PUT", "/api/staff/duty").ok);
  assert.ok(a.check(ops, "POST", "/api/staff/rides/4/contact-log").ok);
  assert.ok(a.check(ops, "POST", "/api/calls/staff/ride/4/start").ok);
  assert.ok(!a.check(ops, "POST", "/api/staff/rides/4/reassign").ok, "moving rides needs manage");
});

test("support starts narrow", () => {
  assert.ok(a.check(support, "GET", "/api/admin/riders").ok);
  assert.ok(a.check(support, "GET", "/api/support/tickets").ok);
  assert.ok(!a.check(support, "PATCH", "/api/support/tickets/3").ok, "closing tickets is granted per person, like before");
  assert.ok(!a.check(support, "PATCH", "/api/admin/panics/7/resolve").ok, "panics are view only");
  assert.ok(!a.check(support, "GET", "/api/admin/wallet-transactions").ok);
  assert.ok(a.check(support, "GET", "/api/admin/exports").ok, "support keeps the operational exports they were designed to have");
});

test("the narrow path wins over the broad one", () => {
  assert.strictEqual(a.requirementFor("PATCH", "/api/admin/riders/5/wallet-adjust").area, "wallet");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/riders").area, "riders");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/rides/live").area, "live-map");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/rides").area, "rides");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/express/prices").area, "express-pricing");
  assert.strictEqual(a.requirementFor("POST", "/api/admin/cashouts/3/approve").area, "express-pricing");
});

test("reads need view, changes need manage", () => {
  assert.strictEqual(a.requirementFor("GET", "/api/admin/drivers").need, "view");
  assert.strictEqual(a.requirementFor("PATCH", "/api/admin/drivers/1/verify").need, "manage");
  assert.strictEqual(a.requirementFor("DELETE", "/api/admin/partner-venues/1").need, "manage");
});

test("only the real export endpoints count as Exports", () => {
  assert.strictEqual(a.requirementFor("GET", "/api/admin/exports").area, "exports");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/exports/history").area, "exports");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/exports/riders").area, "exports");
  assert.strictEqual(a.requirementFor("GET", "/api/admin/exports/riders/extra/path"), null);
});

test("paths outside every area are left to the old checks", () => {
  for (const p of ["/api/staff/people", "/api/staff/access/me", "/api/alerts", "/api/on-the-go", "/api/calls/token", "/api/admin/payment-exceptions", "/api/rides"]) {
    assert.strictEqual(a.requirementFor("GET", p), null, p);
  }
});

test("a per-person grant and a per-person removal both apply", () => {
  const s = { ...support, staff_permissions: { wallet: "manage", riders: "none" } };
  assert.ok(a.check(s, "PATCH", "/api/admin/riders/5/wallet-adjust").ok);
  assert.ok(!a.check(s, "GET", "/api/admin/riders").ok);
});

test("junk in stored permissions is ignored", () => {
  const s = { ...ops, staff_permissions: { wallet: "god", nope: "manage", drivers: 7 } };
  assert.deepStrictEqual(a.effectivePermissions(s), a.PRESETS.operations);
});

test("the owner has everything whatever is stored", () => {
  const o = { ...owner, staff_permissions: { wallet: "none" } };
  for (const id of a.AREA_IDS) assert.strictEqual(a.effectivePermissions(o)[id], "manage");
});

test("only differences from the preset are stored", () => {
  assert.deepStrictEqual(a.diffFromPreset("support", { ...a.PRESETS.support, wallet: "view" }), { wallet: "view" });
  assert.deepStrictEqual(a.diffFromPreset("admin", a.PRESETS.admin), {});
});

test("riders and drivers have no console permissions", () => {
  assert.strictEqual(a.effectivePermissions({ role: "rider" }), null);
  assert.strictEqual(a.effectivePermissions({ role: "driver" }), null);
});

test("who may change someone's access", () => {
  const delegated = { id: 10, role: "admin", can_manage_staff: true };
  assert.ok(checkPermissionChange(owner, { id: 2, role: "support" }).ok);
  assert.ok(checkPermissionChange(owner, { id: 1, role: "admin" }).ok);
  assert.ok(checkPermissionChange(delegated, { id: 2, role: "support" }).ok);
  assert.strictEqual(checkPermissionChange(delegated, { id: 1, role: "admin" }).code, "admin_protected");
  assert.strictEqual(checkPermissionChange(admin, { id: 2, role: "support" }).code, "not_allowed");
  assert.strictEqual(checkPermissionChange(owner, { id: 44, role: "admin", is_owner: true }).code, "owner_protected");
  assert.strictEqual(checkPermissionChange(delegated, { id: 10, role: "admin" }).code, "self");
  assert.strictEqual(checkPermissionChange(owner, { id: 50, role: "rider" }).code, "not_staff");
});

console.log(`\nstaffAccess: ${passed} passed`);
