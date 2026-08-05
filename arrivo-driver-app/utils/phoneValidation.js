// Country calling-code data and phone validation for the driver app —
// a byte-for-byte copy of arrivo-app/utils/phoneValidation.js (which was
// itself ported from the website's phone-input.js). The two Expo projects
// share no package, so this is duplicated rather than imported, the same
// way theme/tokens.js and components/UI.js already are. Keep them in step:
// a driver number and a rider number are compared and dialled by the same
// backend, so they cannot disagree about what a valid number looks like.
//
// ONE canonical storage format everywhere: E.164 — a leading "+", the
// country calling code, then the national number, no spaces or
// punctuation (e.g. "+2348012345678"). A driver's number was collected as
// free text at signup and got saved bare ("08012345678"), which is what
// the rider app puts behind its "call your driver" button (tel: link in
// TrackingScreen) — a bare number doesn't dial for a rider whose phone is
// roaming on a foreign network, which is most of this product's users.
// Every field now goes through PhoneInput + validatePhone /
// validateOptionalPhone, and validatePhone().full is the only value that
// should ever be sent to the backend.
//
// Deliberately a plain array, not a phone-number npm library — covers the
// countries actually relevant to RideArrivo's user mix (Nigeria + its
// neighbours, plus the other markets already supported), with a real
// min/max national-number-length check per country, which catches the
// most common mistake: picking the wrong country code and pasting a
// number that obviously doesn't fit it.
export const COUNTRY_CODES = [
  { code: "NG", dial: "+234", name: "Nigeria", minLen: 10, maxLen: 10 },
  { code: "GH", dial: "+233", name: "Ghana", minLen: 9, maxLen: 9 },
  { code: "BJ", dial: "+229", name: "Benin", minLen: 8, maxLen: 8 },
  { code: "NE", dial: "+227", name: "Niger", minLen: 8, maxLen: 8 },
  { code: "TG", dial: "+228", name: "Togo", minLen: 8, maxLen: 8 },
  { code: "CI", dial: "+225", name: "Côte d'Ivoire", minLen: 8, maxLen: 10 },
  { code: "CM", dial: "+237", name: "Cameroon", minLen: 9, maxLen: 9 },
  { code: "SN", dial: "+221", name: "Senegal", minLen: 9, maxLen: 9 },
  { code: "GB", dial: "+44", name: "United Kingdom", minLen: 10, maxLen: 10 },
  { code: "US", dial: "+1", name: "United States", minLen: 10, maxLen: 10 },
  { code: "CA", dial: "+1", name: "Canada", minLen: 10, maxLen: 10 },
  { code: "FR", dial: "+33", name: "France", minLen: 9, maxLen: 9 },
  { code: "DE", dial: "+49", name: "Germany", minLen: 10, maxLen: 11 },
  { code: "CN", dial: "+86", name: "China", minLen: 11, maxLen: 11 },
  { code: "IN", dial: "+91", name: "India", minLen: 10, maxLen: 10 },
  { code: "PT", dial: "+351", name: "Portugal", minLen: 9, maxLen: 9 },
  { code: "BR", dial: "+55", name: "Brazil", minLen: 10, maxLen: 11 },
  { code: "ES", dial: "+34", name: "Spain", minLen: 9, maxLen: 9 },
  { code: "ZA", dial: "+27", name: "South Africa", minLen: 9, maxLen: 9 },
  { code: "AE", dial: "+971", name: "United Arab Emirates", minLen: 9, maxLen: 9 },
];

// Nigeria is the home market, so it's the sensible starting selection for
// a picker the rider hasn't touched yet.
export const DEFAULT_DIAL = "+234";

export function validatePhone(dialCode, nationalNumber) {
  const digitsOnly = (nationalNumber || "").replace(/\D/g, "");
  const country = COUNTRY_CODES.find((c) => c.dial === dialCode);

  if (!country) return { valid: false, message: "Please choose a country code." };
  if (!digitsOnly) return { valid: false, message: "Please enter a phone number." };
  if (digitsOnly.length < country.minLen || digitsOnly.length > country.maxLen) {
    return {
      valid: false,
      message:
        country.minLen === country.maxLen
          ? `A ${country.name} number should have ${country.minLen} digits after the country code.`
          : `A ${country.name} number should have ${country.minLen}-${country.maxLen} digits after the country code.`,
    };
  }
  return { valid: true, full: dialCode + digitsOnly };
}

// For genuinely optional fields (the extra phone on signup, the per-ride
// emergency contact) — blank is fine and yields `full: null`, but the
// moment anything is typed it has to be a real number with a country code
// like every other field. "Optional" was never meant to mean "unchecked".
export function validateOptionalPhone(dialCode, nationalNumber) {
  if (!(nationalNumber || "").replace(/\D/g, "")) return { valid: true, full: null };
  return validatePhone(dialCode, nationalNumber);
}

// Inverse of validatePhone().full: takes a stored number and works out
// which country code to preselect in the picker and what to leave in the
// national-number box. Needed anywhere an already-saved number is loaded
// back into a PhoneInput for editing (Profile's WhatsApp number,
// RouteScreen pre-filling from a saved emergency contact).
//
// Longest dial prefix wins, so "+2348012345678" is read as Nigeria and not
// as some shorter code that happens to be a prefix of +234. Numbers saved
// before this screen used a country code at all arrive here bare — those
// fall back to `fallbackDial` with the national trunk "0" stripped
// ("08012345678" -> +234 / 8012345678), which is what the rider meant and
// what they'd otherwise have to retype by hand.
const BY_DIAL_LENGTH_DESC = [...COUNTRY_CODES].sort((a, b) => b.dial.length - a.dial.length);

export function splitPhone(full, fallbackDial = DEFAULT_DIAL) {
  const raw = (full || "").trim();
  if (!raw) return { dial: fallbackDial, national: "" };

  if (raw.startsWith("+")) {
    const compact = "+" + raw.slice(1).replace(/\D/g, "");
    const match = BY_DIAL_LENGTH_DESC.find((c) => compact.startsWith(c.dial));
    if (match) return { dial: match.dial, national: compact.slice(match.dial.length) };
  }

  return { dial: fallbackDial, national: raw.replace(/\D/g, "").replace(/^0/, "") };
}
