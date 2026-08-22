// The privacy summary shown in the signup modal, kept here so the copy can be
// updated without touching the screen. This is a summary, not the whole
// policy. The full text lives on the website at PRIVACY_FULL_URL and this has
// to stay consistent with it.
//
// Keep it honest about location: the app collects precise GPS during a trip,
// and that has to be disclosed here as well as in the store listings.
//
// House copy rule: no em dashes in anything a user reads.

export const PRIVACY_LAST_UPDATED = "August 22, 2026";
export const PRIVACY_FULL_URL = "ridearrivo.com/privacy.html";

export const PRIVACY_SECTIONS = [
  {
    title: "What we collect",
    body:
      "Your name, email address, phone number and preferred language, plus a hashed password. We never store your password as plain text.\n\n" +
      "Your trips: pickup and drop-off locations, flight numbers, luggage details, trip history and fares.\n\n" +
      "Device information such as your IP address, operating system and device ID, along with app usage analytics.\n\n" +
      "Precise GPS location while a trip is active.",
  },
  {
    title: "How we use it",
    body:
      "To match you with a driver and run your trip, to take payment through our payment provider, to send you ride updates, receipts, account notices and safety alerts, and to meet tax and transport rules in Lagos State.",
  },
  {
    title: "Who we share it with",
    body:
      "We do not sell your personal data.\n\n" +
      "Your driver sees the name, contact options and locations needed to pick you up and route the trip. Payments run through Paystack and flight status comes from AviationStack.\n\n" +
      "We give your data or GPS location to police, government bodies or legal authorities only against a valid court order, subpoena or legally binding request under Nigerian law, or where somebody is in immediate physical danger.",
  },
  {
    title: "Where it is kept",
    body:
      "Everything in transit is encrypted over HTTPS, and access is limited to the people who need it. Your data may sit on secure cloud servers outside Nigeria. Any transfer abroad follows NDPA safeguards so it keeps equivalent protection.",
  },
  {
    title: "How long we keep it",
    body:
      "We hold your profile and trip records for as long as your account is open. If you delete your account we keep minimal transaction records for up to 7 years to satisfy tax, accounting and dispute rules, then erase them for good.",
  },
  {
    title: "Your rights",
    body:
      "Under the NDPA you can ask for a copy of your data, correct it, have your account and data deleted, or object to certain processing. Email privacy@ridearrivo.com to do any of that or to reach our Data Protection Officer. You can also complain to the Nigeria Data Protection Commission.",
  },
  {
    title: "Age",
    body: "RideArrivo is for people aged 18 and over. We do not knowingly collect data from children.",
  },
];
