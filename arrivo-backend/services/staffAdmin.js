// Who may change whose role. Pure rules, no database, so every case is testable.
//   actor:  { id, role, is_owner, can_manage_staff }
//   target: { id, role, is_owner }
//
//   Owner              anything, except demoting themselves or the last owner
//   Admin with         promote, move and remove support and operations people,
//   can_manage_staff   never admins or the owner
//   Everyone else      nothing
// Only the owner makes admins, removes admins, or grants the delegated privilege.

const STAFF_ROLES = ["admin", "support", "operations"];
const LOWER_STAFF = ["support", "operations"];

const fail = (status, code, error) => ({ ok: false, status, code, error });
const ok = () => ({ ok: true });

function canManagePeople(actor) {
  if (!actor) return false;
  if (actor.is_owner) return true;
  return actor.role === "admin" && !!actor.can_manage_staff;
}

// Change target's role to newRole. "rider" means removed from staff.
// ownersLeft: how many owners exist (so the last one is never lost).
function checkRoleChange(actor, target, newRole, { ownersLeft = 1 } = {}) {
  if (!canManagePeople(actor)) return fail(403, "not_allowed", "You do not have permission to manage staff.");
  if (!target) return fail(404, "not_found", "That person was not found.");
  if (![...STAFF_ROLES, "rider"].includes(newRole)) return fail(400, "bad_role", "Role must be admin, support, operations, or rider (to remove).");
  if (target.role === "driver") return fail(409, "is_driver", "Drivers cannot be made staff from here.");
  if (target.role === newRole) return fail(409, "no_change", "They already have that role.");

  if (Number(target.id) === Number(actor.id)) {
    return fail(403, "self", "You cannot change your own role. Ask another owner.");
  }
  if (target.is_owner) {
    return fail(403, "owner_protected", "The owner's role cannot be changed here.");
  }
  if (actor.is_owner) return ok();

  // delegated admin: lower staff only
  const touchesAdmin = target.role === "admin" || newRole === "admin";
  if (touchesAdmin) return fail(403, "admin_protected", "Only the owner can make or remove admins.");
  return ok();
}

function checkGrant(actor, target) {
  if (!actor || !actor.is_owner) return fail(403, "owner_only", "Only the owner can grant or revoke this.");
  if (!target) return fail(404, "not_found", "That person was not found.");
  if (target.role !== "admin") return fail(409, "not_admin", "Only an admin can be given staff management.");
  return ok();
}

// Change what someone can see and do in the console (services/staffAccess.js).
// Same lines as a role change: not yourself, never the owner, and only the
// owner touches an admin's access.
function checkPermissionChange(actor, target) {
  if (!canManagePeople(actor)) return fail(403, "not_allowed", "You do not have permission to manage staff.");
  if (!target) return fail(404, "not_found", "That person was not found.");
  if (!STAFF_ROLES.includes(target.role)) return fail(409, "not_staff", "Only staff accounts have console permissions.");
  if (Number(target.id) === Number(actor.id)) return fail(403, "self", "You cannot change your own access. Ask the owner.");
  if (target.is_owner) return fail(403, "owner_protected", "The owner always has full access.");
  if (!actor.is_owner && target.role === "admin") return fail(403, "admin_protected", "Only the owner can change an admin's access.");
  return ok();
}

module.exports = { STAFF_ROLES, LOWER_STAFF, canManagePeople, checkRoleChange, checkGrant, checkPermissionChange };
