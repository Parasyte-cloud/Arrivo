const assert = require("assert");
const r = require("./staffAdmin");
let n = 0; const t = (name, fn) => { fn(); console.log("  ok  " + name); n++; };
const owner = { id: 1, role: "admin", is_owner: true };
const dele = { id: 2, role: "admin", can_manage_staff: true };
const plain = { id: 3, role: "admin" };
const lead = { id: 4, role: "support", support_lead: true };
const P = (id, role, extra = {}) => ({ id, role, ...extra });

t("owner promotes a rider to support", () => assert.ok(r.checkRoleChange(owner, P(9, "rider"), "support").ok));
t("owner makes an admin and removes one", () => {
  assert.ok(r.checkRoleChange(owner, P(9, "support"), "admin").ok);
  assert.ok(r.checkRoleChange(owner, P(9, "admin"), "rider").ok);
});
t("nobody changes their own role, owner included", () => assert.strictEqual(r.checkRoleChange(owner, owner, "support").code, "self"));
t("the owner cannot be demoted by anyone", () => assert.strictEqual(r.checkRoleChange(dele, P(1, "admin", { is_owner: true }), "support").code, "owner_protected"));
t("delegated admin manages support and operations", () => {
  assert.ok(r.checkRoleChange(dele, P(9, "rider"), "operations").ok);
  assert.ok(r.checkRoleChange(dele, P(9, "support"), "operations").ok);
  assert.ok(r.checkRoleChange(dele, P(9, "support"), "rider").ok);
});
t("delegated admin cannot touch admins or make admins", () => {
  assert.strictEqual(r.checkRoleChange(dele, P(9, "admin"), "support").code, "admin_protected");
  assert.strictEqual(r.checkRoleChange(dele, P(9, "support"), "admin").code, "admin_protected");
  assert.strictEqual(r.checkRoleChange(dele, P(9, "admin"), "rider").code, "admin_protected");
});
t("plain admin, head of support and others cannot manage staff", () => {
  for (const a of [plain, lead, P(5, "operations"), P(6, "rider"), null]) assert.strictEqual(r.checkRoleChange(a, P(9, "rider"), "support").status, 403);
});
t("drivers are refused, same role is a no-op, bad role is 400", () => {
  assert.strictEqual(r.checkRoleChange(owner, P(9, "driver"), "support").code, "is_driver");
  assert.strictEqual(r.checkRoleChange(owner, P(9, "support"), "support").code, "no_change");
  assert.strictEqual(r.checkRoleChange(owner, P(9, "rider"), "root").code, "bad_role");
});
t("only the owner grants, and only to admins", () => {
  assert.ok(r.checkGrant(owner, P(9, "admin")).ok);
  assert.strictEqual(r.checkGrant(dele, P(9, "admin")).code, "owner_only");
  assert.strictEqual(r.checkGrant(owner, P(9, "support")).code, "not_admin");
  assert.strictEqual(r.checkGrant(owner, null).status, 404);
});
console.log(`${n} passed`);
