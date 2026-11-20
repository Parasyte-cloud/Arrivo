// Run directly: node utils/flightFields.test.js
import assert from "node:assert";
import { flightNumberProblem, flightDateProblem, pnrProblem, addDays } from "./flightFields.js";

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`ok  ${name}`); };

test("real flight numbers pass in any casing or spacing", () => {
  for (const v of ["BA75", "ba 075", "ET-905", "W3 123", "3K5", "BAW75", ""]) assert.equal(flightNumberProblem(v), null, v);
});

test("a booking code in the flight box is named as one", () => {
  assert.match(flightNumberProblem("XQ7K9P"), /booking code/);
  assert.match(flightNumberProblem("Lagos"), /airline code/);
});

test("the date must be real and not in the past", () => {
  assert.equal(flightDateProblem("2026-11-02", "2026-11-01"), null);
  assert.equal(flightDateProblem("2026-11-01", "2026-11-01"), null);
  assert.match(flightDateProblem("2026-10-31", "2026-11-01"), /passed/);
  assert.match(flightDateProblem("02/11/2026", "2026-11-01"), /year-month-day/);
  assert.match(flightDateProblem("2026-02-30", "2026-11-01"), /real date/);
});

test("the booking code is optional and 5 to 8 characters", () => {
  assert.equal(pnrProblem(""), null);
  assert.equal(pnrProblem("ab12cd"), null);
  assert.match(pnrProblem("ab"), /5 to 8/);
});

test("tomorrow is a day on", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
});

console.log(`\n${n} passed`);
