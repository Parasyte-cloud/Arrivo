// Pure cash-out rules: no database, no Paystack.
const assert = require("assert");
const { namesMatch, maskAccount, validAccountNumber, computeWithdrawable, checkRequest, limits } = require("./driverCashout");

let passed = 0;
const test = (n, f) => { try { f(); console.log(`  ok  ${n}`); passed++; } catch (e) { console.log(`FAIL  ${n}\n${e.stack}`); process.exitCode = 1; } };
const LIM = { minNaira: 1000, maxNaira: 200000, dailyMaxNaira: 300000, reviewAboveNaira: 100000, bankCoolingHours: 24, feeNaira: 0, maxAttempts: 10 };
const ok = { amount: 5000, withdrawable: 20000, spentToday: 0, hoursSinceBankChange: 48 };

test("account name must share a name with the profile", () => {
  assert.ok(namesMatch("LAWAL BIOLA SHERIFF", "Biola Lawal"));
  assert.ok(namesMatch("Ade Okoro", "okoro"));
  assert.ok(!namesMatch("CHUKWU EMEKA", "Biola Lawal"));
  assert.ok(!namesMatch("", "Biola"));
  assert.ok(!namesMatch("Ade Okoro", ""));
});

test("account numbers are masked and validated", () => {
  assert.strictEqual(maskAccount("0123456789"), "******6789");
  assert.ok(validAccountNumber("0123456789"));
  assert.ok(!validAccountNumber("123456789"));
  assert.ok(!validAccountNumber("01234567890"));
  assert.ok(!validAccountNumber("01234abcde"));
});

test("only earnings can be withdrawn, never more than the balance", () => {
  assert.strictEqual(computeWithdrawable({ balance: 10000, creditsEarned: 4000, withdrawnActive: 0 }), 4000);
  assert.strictEqual(computeWithdrawable({ balance: 3000, creditsEarned: 4000, withdrawnActive: 0 }), 3000);
  assert.strictEqual(computeWithdrawable({ balance: 10000, creditsEarned: 4000, withdrawnActive: 4000 }), 0);
  assert.strictEqual(computeWithdrawable({ balance: 10000, creditsEarned: 4000, withdrawnActive: 9000 }), 0);
  assert.strictEqual(computeWithdrawable({ balance: 0, creditsEarned: 0, withdrawnActive: 0 }), 0);
});

test("a normal request passes", () => assert.strictEqual(checkRequest(ok, LIM), null));

test("each limit is enforced with a clear reason", () => {
  assert.strictEqual(checkRequest({ ...ok, amount: 0 }, LIM).code, "INVALID_AMOUNT");
  assert.strictEqual(checkRequest({ ...ok, amount: 12.5 }, LIM).code, "INVALID_AMOUNT");
  assert.strictEqual(checkRequest({ ...ok, amount: 500 }, LIM).code, "BELOW_MINIMUM");
  assert.strictEqual(checkRequest({ ...ok, amount: 250000, withdrawable: 999999 }, LIM).code, "ABOVE_MAXIMUM");
  assert.strictEqual(checkRequest({ ...ok, hoursSinceBankChange: 3 }, LIM).code, "BANK_COOLING_OFF");
  assert.strictEqual(checkRequest({ ...ok, amount: 30000 }, LIM).code, "INSUFFICIENT_WITHDRAWABLE");
  assert.strictEqual(checkRequest({ ...ok, withdrawable: 999999, spentToday: 298000 }, LIM).code, "DAILY_LIMIT");
});

test("a fee counts against what can be withdrawn", () => {
  assert.strictEqual(checkRequest({ ...ok, amount: 20000 }, { ...LIM, feeNaira: 50 }).code, "INSUFFICIENT_WITHDRAWABLE");
  assert.strictEqual(checkRequest({ ...ok, amount: 19950 }, { ...LIM, feeNaira: 50 }), null);
});

test("limits() has safe defaults", () => {
  const l = limits();
  assert.ok(l.minNaira >= 1 && l.maxNaira > l.minNaira && l.dailyMaxNaira >= l.maxNaira && l.bankCoolingHours >= 1);
});

console.log(`\n${passed} passed`);
