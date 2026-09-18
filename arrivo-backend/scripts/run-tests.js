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
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// Found rather than listed. A hand kept list went stale within a week: three
// suites landed on main and nothing ran them.
function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, found);
    else if (entry.name.endsWith(".test.js")) found.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return found.sort();
}

// Anything named *.integration.test.js needs a live database, so it is opt in.
// services/telemetry/integration.test.js is not one of those, despite the name.
const all = findTests(root);
const INTEGRATION = all.filter((f) => path.basename(f).endsWith(".integration.test.js"));
const UNIT = all.filter((f) => !INTEGRATION.includes(f));

const wantIntegration = process.argv.includes("--integration");
const files = wantIntegration ? [...UNIT, ...INTEGRATION] : UNIT;

if (wantIntegration && !process.env.DATABASE_URL) {
  console.error("test:integration needs DATABASE_URL set to a throwaway database.");
  process.exit(1);
}

// Suites report in three styles: "12 passed", "9 test(s) passed", and
// node:test's "# pass 4". Normalise them for the summary line.
function summarise(output) {
  const plain = output.match(/^\s*(\d+) (?:test\(s\) )?passed\s*$/m);
  if (plain) return `${plain[1]} passed`;
  const tap = output.match(/^# pass (\d+)/m);
  if (tap) return `${tap[1]} passed`;
  return "";
}

// Unit suites must not need a database. Give them a URL that goes nowhere so
// one that quietly starts depending on Postgres fails here instead of passing
// only on machines that happen to have one.
function envFor(file) {
  if (INTEGRATION.includes(file)) return process.env;
  return { ...process.env, DATABASE_URL: "postgresql://unit-tests:none@127.0.0.1:1/none" };
}

let failed = 0;
const results = [];

for (const file of files) {
  const run = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8", env: envFor(file) });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const ok = run.status === 0;
  if (!ok) failed++;

  const summary = summarise(output);
  results.push({ file, ok, summary, output });
  console.log(`${ok ? "  ok  " : "FAIL  "}${file.padEnd(46)}${summary}`);
  if (!ok) console.log(output.split("\n").filter((l) => /FAIL|not ok|Error|error:/.test(l)).slice(0, 8).map((l) => `        ${l}`).join("\n"));
}

console.log("");
if (!wantIntegration) {
  console.log("  unit tests only. run `npm run test:integration` with DATABASE_URL for the rest.");
}
console.log(`  ${results.length - failed} of ${results.length} suites passed`);
process.exit(failed ? 1 : 0);
