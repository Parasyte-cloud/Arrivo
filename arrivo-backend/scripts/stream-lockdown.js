// Stops signed-in apps from creating Stream calls themselves.
//
//   node scripts/stream-lockdown.js            show what would change (dry run)
//   node scripts/stream-lockdown.js --apply    make the change
//   node scripts/stream-lockdown.js --undo     put create-call back (rollback)
//
// Calls between a rider and their driver are now created by the server
// (routes/calls.js), which checks that the two people are on the same live ride.
// Until this runs, a modified app could still ask Stream to ring any user id
// directly. Run it ONLY after the updated rider and driver apps are live: the
// old apps create calls on the device and will stop being able to call.
//
// Staff keep calling because the server gives them Stream's built-in "admin"
// role (see streamRoleFor in routes/calls.js). They must sign in again, or
// request a new calling token, for that role to be applied.
//
// Needs STREAM_API_KEY and STREAM_API_SECRET.

const { StreamClient } = require("@stream-io/node-sdk");

const CALL_TYPE = process.env.STREAM_CALL_TYPE || "default";
const ROLE = "user";
const CAPABILITY = "create-call";

async function main() {
  const apply = process.argv.includes("--apply");
  const undo = process.argv.includes("--undo");
  if (!process.env.STREAM_API_KEY || !process.env.STREAM_API_SECRET) {
    console.error("Set STREAM_API_KEY and STREAM_API_SECRET first.");
    process.exit(1);
  }
  const client = new StreamClient(process.env.STREAM_API_KEY, process.env.STREAM_API_SECRET);

  const current = await client.video.getCallType({ name: CALL_TYPE });
  const grants = JSON.parse(JSON.stringify(current.grants || {}));
  const had = (grants[ROLE] || []).includes(CAPABILITY);
  console.log(`Call type "${CALL_TYPE}", role "${ROLE}": ${had ? "CAN" : "cannot"} create calls today.`);

  if (undo) {
    if (had) return console.log("Nothing to undo.");
    grants[ROLE] = [...(grants[ROLE] || []), CAPABILITY];
  } else {
    if (!had) return console.log("Already locked down. Nothing to do.");
    grants[ROLE] = (grants[ROLE] || []).filter((c) => c !== CAPABILITY);
  }

  if (!apply && !undo) {
    console.log(`Dry run. With --apply, "${CAPABILITY}" is removed from "${ROLE}". Make sure the new apps are out first.`);
    return;
  }
  await client.video.updateCallType({ name: CALL_TYPE, grants });
  console.log(undo ? `Restored "${CAPABILITY}" for "${ROLE}".` : `Done. Apps can no longer create calls; the server does it.`);
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
