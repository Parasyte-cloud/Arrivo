const express = require("express");
const { pool } = require("../db/db");
const { requireAuth } = require("../middleware/auth");
const { getStreamClients } = require("./calls");

const router = express.Router();

// POST /api/chat/ride-channel
// body: { rideId }
// Get-or-creates the one text-chat channel for a given ride, scoped to
// exactly the rider and the assigned driver — never any other user, even
// another admin/support account, can be added as a member here. Lazily
// provisioned the first time either side opens the chat screen, rather
// than needing a separate step wired into ride-acceptance — mirrors how
// in-app calling itself needs no advance setup beyond the ride existing.
router.post("/ride-channel", requireAuth, async (req, res) => {
  const { rideId } = req.body;
  if (!rideId) return res.status(400).json({ error: "rideId is required" });

  let clients;
  try {
    clients = getStreamClients();
  } catch (e) {
    console.error("Stream client not configured:", e.message);
    return res.status(502).json({ error: "Chat isn't set up on the server yet. Please try again later." });
  }

  try {
    // driver_users.id as driver_user_id — same join pattern as GET
    // /api/rides/:id (routes/rides.js), needed because rides.driver_id
    // points at the drivers table's own id, not the driver's users.id.
    const result = await pool.query(
      `SELECT rides.rider_id, driver_users.id as driver_user_id
       FROM rides
       LEFT JOIN drivers ON drivers.id = rides.driver_id
       LEFT JOIN users driver_users ON driver_users.id = drivers.user_id
       WHERE rides.id = $1`,
      [rideId]
    );
    const ride = result.rows[0];
    if (!ride) return res.status(404).json({ error: "Ride not found" });

    // Only the rider who booked it or the assigned driver may open/create
    // this channel — the same access rule GET /api/rides/:id already
    // enforces for viewing the ride itself.
    const isRider = ride.rider_id === req.user.id;
    const isAssignedDriver = ride.driver_user_id === req.user.id;
    if (!isRider && !isAssignedDriver) {
      return res.status(403).json({ error: "You're not part of this ride." });
    }
    if (!ride.driver_user_id) {
      return res.status(409).json({ error: "This ride doesn't have a driver assigned yet." });
    }

    const riderId = String(ride.rider_id);
    const driverId = String(ride.driver_user_id);
    const channelId = `ride-${rideId}`;

    await clients.chat.upsertUsers([
      { id: riderId },
      { id: driverId },
    ]);

    const channel = clients.chat.channel("messaging", channelId, {
      members: [riderId, driverId],
      created_by_id: riderId,
    });
    await channel.create();

    res.json({ channelType: "messaging", channelId });
  } catch (err) {
    console.error("Chat channel provisioning failed:", err.message);
    res.status(502).json({ error: "Could not open chat right now. Please try again." });
  }
});

module.exports = router;
