// GET /api/staff/access/me       what the signed-in staff member can see and change
// GET /api/staff/access/catalog  the console areas, levels and role presets, for the Team page
const express = require("express");
const { pool } = require("../db/db");
const { requireAuth, requireAnyRole } = require("../middleware/auth");
const access = require("../services/staffAccess");
const { canManagePeople } = require("../services/staffAdmin");

const router = express.Router();
router.use(requireAuth, requireAnyRole(access.STAFF_ROLES));

router.get("/me", async (req, res) => {
  const me = (await pool.query(
    "SELECT id, role, is_owner, can_manage_staff, support_lead, staff_permissions FROM users WHERE id = $1",
    [req.user.id]
  )).rows[0];
  res.json({
    role: me.role,
    isOwner: !!me.is_owner,
    canManageStaff: canManagePeople(me),
    canSeeTeam: me.role === "admin" || !!me.is_owner || (me.role === "support" && !!me.support_lead),
    permissions: access.effectivePermissions(me),
  });
});

router.get("/catalog", (req, res) => {
  res.json({
    levels: access.LEVELS,
    // Sidebar order, not the matching order the rules need.
    areas: access.DISPLAY_ORDER.map((id) => access.AREAS.find((a) => a.id === id)).map((a) => ({ id: a.id, label: a.label })),
    presets: access.PRESETS,
  });
});

module.exports = router;
