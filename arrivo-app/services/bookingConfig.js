import { getBookingConfig } from "./api";
import { setBookingRulesFromConfig } from "../utils/bookingWindow";
import { setSupportContactsFromConfig } from "../utils/supportContacts";

// Pulls the booking rules and support contacts the backend serves and applies
// them. Called once when the app starts. If the request fails (offline, an
// older backend without the endpoint, anything else) nothing changes and the
// values bundled in the app keep working, so this can never get in the way of
// booking.
export async function loadBookingConfig() {
  try {
    const config = await getBookingConfig();
    setBookingRulesFromConfig(config);
    setSupportContactsFromConfig(config && config.support);
    return true;
  } catch (e) {
    return false;
  }
}
