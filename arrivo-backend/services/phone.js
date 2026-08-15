// One phone format for the whole system: E.164, so always a leading + and the
// country code. Emergency contacts used to come in as bare local numbers
// ("08037406085") while the rider's own number on the same account was already
// "+234...", which made them impossible to compare or dial reliably.
//
// The apps do the richer per-country length check (see
// arrivo-app/utils/phoneValidation.js, which knows how many digits a Nigerian
// or Ghanaian number should have). This is the shape check that everything has
// to pass regardless of which client it came from.

// Leading +, a country code that can't start with 0, then 7 to 14 more digits.
// That's 8 to 15 digits in total, which is what E.164 allows.
const E164 = /^\+[1-9]\d{7,14}$/;

function isValidPhone(value) {
  return E164.test(String(value == null ? "" : value).trim());
}

// Same wording everywhere so a rider doesn't get three different phrasings for
// the same mistake depending on which screen they're on.
function phoneErrorMessage(label) {
  return `${label} must include the country code, for example +2348012345678.`;
}

module.exports = { isValidPhone, phoneErrorMessage };
