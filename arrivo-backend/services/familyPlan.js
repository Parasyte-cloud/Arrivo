// Shared helper between routes/family.js (plan/member management) and
// routes/rides.js (paying for a ride from the family wallet) -- kept in
// one place so "what counts as this user's active family plan" can never
// drift between the two call sites.
const PLAN_LIMITS = { lite: 2, plus: 3, max: 5 };

async function getActivePlanForUser(pool, userId) {
  const result = await pool.query(
    `SELECT fp.*, fm.member_role, fm.id AS membership_id
       FROM family_members fm
       JOIN family_plans fp ON fp.id = fm.family_plan_id
      WHERE fm.user_id = $1 AND fm.status = 'active' AND fp.status = 'active'
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = { PLAN_LIMITS, getActivePlanForUser };
