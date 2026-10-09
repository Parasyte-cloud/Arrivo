// How to reach Support, in one place. The defaults are bundled so the app works
// offline and before the config arrives; GET /api/config/booking can change
// them without an app release (see services/bookingConfig.js).
//
// Import-free so utils/supportContacts.test.js can load it with node.

const DEFAULTS = {
  phone: "+2348162706078",
  phoneDisplay: "+234 816 270 6078",
  email: "info@ridearrivo.com",
};

let contacts = { ...DEFAULTS };

export function getSupportContacts() {
  return contacts;
}

// https://wa.me/ link, optionally with a prefilled message.
export function whatsappUrl(message) {
  const base = `https://wa.me/${contacts.phone.replace("+", "")}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

// Takes the "support" object from the config. Each field is checked on its own,
// and one bad value never blocks the others.
export function setSupportContactsFromConfig(raw) {
  if (!raw || typeof raw !== "object") return;
  const next = { ...contacts };
  if (typeof raw.phone === "string" && /^\+\d{8,15}$/.test(raw.phone.trim())) next.phone = raw.phone.trim();
  if (typeof raw.phoneDisplay === "string" && raw.phoneDisplay.trim() && raw.phoneDisplay.length <= 32) {
    next.phoneDisplay = raw.phoneDisplay.trim();
  } else if (next.phone !== contacts.phone) {
    next.phoneDisplay = next.phone;
  }
  if (typeof raw.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email.trim())) next.email = raw.email.trim();
  contacts = next;
}

export function resetSupportContacts() {
  contacts = { ...DEFAULTS };
}
