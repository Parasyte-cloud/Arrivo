// Runs the backend test suite. There was no test command at all, so the tests
// that existed only ran if somebody remembered each filename.
//
//   npm test                  unit tests, no database needed
//   npm run test:integration  the above plus the route and concurrency tests,
//                             which need a real Postgres
//
// Integration tests need DATABASE_URL pointing at a database you do not mind
// being written to. They create their own users and clean up after themselves,
// but they are not something to aim at production.

const { spawnSync } = require("child_process");
const path = require("path");

const UNIT = [
  "services/phase2.test.js",
  "services/routeDeviation.test.js",
  "services/telemetry/integration.test.js",
  "services/bookingWindow.test.js",
  "services/accountDeletion.test.js",
  "services/appleRevoke.test.js",
  "routes/support.test.js",
];

// Need a live database, so they are opt in.
const INTEGRATION = ["routes/auth.integration.test.js"];

const wantIntegration = process.argv.includes("--integration");
const files = wantIntegration ? [...UNIT, ...INTEGRATION] : UNIT;

if (wantIntegration && !process.env.DATABASE_URL) {
  console.error("test:integration needs DATABASE_URL set to a throwaway database.");
  process.exit(1);
}

const root = path.join(__dirname, "..");
let failed = 0;
const results = [];

for (const file of files) {
  const run = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const ok = run.status === 0;
  if (!ok) failed++;

  // Each suite prints "N passed". Searched for rather than taken from the last
  // line, since a suite that deliberately logs an error prints after it.
  const summary = (output.match(/^\s*\d+ passed\s*$/m) || [""])[0].trim();
  results.push({ file, ok, summary, output });
  console.log(`${ok ? "  ok  " : "FAIL  "}${file.padEnd(46)}${summary}`);
  if (!ok) console.log(output.split("\n").filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 8).map((l) => `        ${l}`).join("\n"));
}

console.log("");
if (!wantIntegration) {
  console.log("  unit tests only. run `npm run test:integration` with DATABASE_URL for the rest.");
}
console.log(`  ${results.length - failed} of ${results.length} suites passed`);
process.exit(failed ? 1 : 0);
