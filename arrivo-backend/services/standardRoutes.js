// A fixed set of everyday Lagos trips to price-check against other apps, so
// the daily check is "open the other app, type these two places, note the
// price" instead of inventing a trip each time. Using the SAME trips every day
// also makes the numbers comparable from one day to the next.
//
// Distances and times are typical figures, only a starting point: when the
// other app shows its own distance and time for the trip, type those instead,
// because the comparison should use what that rider was actually quoted.

const STANDARD_ROUTES = [
  { id: "lekki1-vi", label: "Lekki Phase 1 to Victoria Island", distanceKm: 12, durationMin: 30 },
  { id: "ikeja-yaba", label: "Ikeja (Allen) to Yaba", distanceKm: 13, durationMin: 35 },
  { id: "surulere-ikeja", label: "Surulere to Ikeja", distanceKm: 12, durationMin: 35 },
  { id: "ajah-lekki1", label: "Ajah to Lekki Phase 1", distanceKm: 22, durationMin: 45 },
  { id: "vi-ikeja", label: "Victoria Island to Ikeja", distanceKm: 22, durationMin: 55 },
  { id: "mmia-ikejagra", label: "Airport (MMIA) to Ikeja GRA", distanceKm: 7, durationMin: 18 },
  { id: "mmia-vi", label: "Airport (MMIA) to Victoria Island", distanceKm: 26, durationMin: 55 },
  { id: "yaba-vi", label: "Yaba to Victoria Island", distanceKm: 14, durationMin: 35 },
  { id: "ikoyi-ikeja", label: "Ikoyi to Ikeja", distanceKm: 20, durationMin: 50 },
  { id: "gbagada-vi", label: "Gbagada to Victoria Island", distanceKm: 16, durationMin: 40 },
  { id: "festac-surulere", label: "Festac to Surulere", distanceKm: 18, durationMin: 45 },
  { id: "magodo-ikeja", label: "Magodo to Ikeja", distanceKm: 8, durationMin: 20 },
];

module.exports = { STANDARD_ROUTES };
