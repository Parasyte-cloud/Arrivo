// The one welfare-check instance the routes and the timer share, wired to the
// panic pager so a welfare alert reaches the same on-call people.
const { pool } = require("../db/db");
const { createWelfareCheck } = require("./welfareCheck");
const { sendPanicAlert } = require("./panicAlert");

const welfareCheck = createWelfareCheck(pool, { onRaise: (rideId, userId) => sendPanicAlert(pool, rideId, userId) });

const SWEEP_MS = 30 * 1000;
let timer = null;
function startWelfareSweep() {
  if (timer) return;
  timer = setInterval(() => { welfareCheck.sweepOverdue().catch((e) => console.error("[welfare] sweep:", e.message)); }, SWEEP_MS);
  if (timer.unref) timer.unref();
}

module.exports = { welfareCheck, startWelfareSweep };
