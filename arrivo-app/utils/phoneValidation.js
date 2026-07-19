// Shared country calling-code data and phone validation, used anywhere a
// phone/WhatsApp number is collected (signup, profile). Ported directly
// from the website's phone-input.js so both platforms validate numbers
// the same way and never disagree about what's a valid entry.
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
