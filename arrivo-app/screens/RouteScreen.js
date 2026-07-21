import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { LiveMap } from "../components/LiveMap";
import AddressAutocomplete from "../components/AddressAutocomplete";
import { colors, spacing, radius } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getFareQuote } from "../services/api";
import { useCurrency } from "../hooks/useCurrency";

// Luxury toggle only makes sense on Sedan/SUV — Executive is already the
// premium tier, and this mirrors LUXURY_SURCHARGE_USD in
// arrivo-backend/services/fare.js (the actual source of truth for the
// surcharge amount; these labels are just for display before a quote loads).
const LUXURY_LABEL_USD = { sedan: 60, suv: 100 };

// Areas RideArrivo doesn't currently serve — kept as an instant, purely
// client-side UX check against whatever text is typed (no need to wait on
// a fare quote to tell someone we don't operate somewhere). The real fare
// itself no longer comes from a local lookup table like this one — see
// the quote-fetching effect below, which calls the backend's
// POST /api/rides/quote (real driving distance via Google, real formula
// in arrivo-backend/services/fare.js).
const EXCLUDED_AREAS = [
  { name: "Badagry", keywords: ["badagry"] },
  { name: "Epe", keywords: ["epe"] },
  { name: "Ibeju-Lekki", keywords: ["ibeju-lekki", "ibeju lekki"] },
  { name: "Makoko", keywords: ["makoko"] },
];
function findExcludedArea(address) {
  const a = " " + (address || "").toLowerCase() + " ";
  return EXCLUDED_AREAS.find((area) => area.keywords.some((k) => a.indexOf(k) !== -1)) || null;
}

// "pickup" (Pickup Truck) is a later addition for heavy/bulky cargo —
// distinct from "truck" (which is actually the Executive Vehicle premium
// tier, an existing internal naming choice kept as-is). It seats fewer
// passengers than SUV/Executive since the bed is for cargo, not people —
// mirrors arrivo-backend/services/fare.js exactly.
const MAX_PASSENGERS = { sedan: 3, suv: 5, truck: 5, pickup: 3 };
// A group bigger than one vehicle's seats no longer blocks booking — it
// books enough of the SAME vehicle type to fit everyone instead (see
// vehicleCount below), same idea as arrivo-backend/services/fare.js's
// computeVehicleCount, which is what actually prices this. Mirrored here
// purely for instant UI feedback before the quote round-trip comes back;
// the backend independently re-derives and enforces the real cap.
const MAX_AUTO_VEHICLE_COUNT = 6;
const VEHICLES = [
  { id: "sedan", label: "Standard Sedan" },
  { id: "suv", label: "Premium SUV" },
  { id: "truck", label: "Executive Vehicle" },
  { id: "pickup", label: "Pickup Truck" },
];

// Auto-recommends a vehicle from luggage + passenger count, same as the
// website's recommendVehicle() — heavy/oversized or a large checked-bag
// count points at the cargo-focused Pickup Truck, a big passenger count
// with normal luggage points at the bigger-seat Executive tier. Only a
// recommendation: riders can always tap a different vehicle manually (see
// the vehicleManuallyPicked-style override below).
function recommendVehicle(checkedBags, bulky, passengers) {
  if (bulky || checkedBags >= 5) return "pickup";
  if (passengers >= 5) return "truck";
  if (checkedBags >= 3 || passengers >= 4) return "suv";
  return "sedan";
}
// "dropoff" (Airport Drop-off) is the mirror image of "one_way" — taking a
// departing rider FROM their location TO the airport, instead of an
// arriving rider FROM the airport. Priced identically server-side (see
// arrivo-backend/services/fare.js) since the per-location formula already
// prices off whichever leg isn't the airport, regardless of direction.
// Unlike "one_way" (whose timing comes from the flight-landing event), a
// drop-off has no such trigger, so it requires an explicit scheduled
// date/time instead (see the "Pickup time" card below).
const BOOKING_TYPES = [
  { id: "one_way", label: "Airport Pickup", days: 1 },
  { id: "dropoff", label: "Airport Drop-off", days: 1 },
  { id: "full_day", label: "Full day", days: 1 },
  { id: "full_week", label: "Full week", days: 7 },
  { id: "full_month", label: "Full month", days: 30 },
];

// Quarter-hour granularity is plenty precise for an airport transfer and
// keeps the picker to simple chips rather than a native date/time picker
// component (none is installed in this project, and adding one means a new
// native dependency + a rebuild before it could ship).
const SCHEDULE_MINUTES = ["00", "15", "30", "45"];

function scheduleDayLabel(offset) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

const QUOTE_DEBOUNCE_MS = 400;

export default function RouteScreen({ navigation, route }) {
  const { token } = useAuth();
  const { formatFare, isNigeria } = useCurrency(token);

  // Empty by default — the rider types their own pickup and destination,
  // matching the website's booking form (no pre-filled locations).
  // presetPickupAddress/presetDestinationAddress/presetBookingType/
  // linkedRideId arrive when this screen is opened from the "book your
  // return drop-off" prompt right after paying for an arrival pickup (see
  // CheckoutScreen) — pre-filling the reversed route so the rider doesn't
  // have to retype their own address or the airport.
  const [pickup, setPickup] = useState(route?.params?.presetPickupAddress || "");
  // Pre-filled from the just-completed ride's own resolved coordinates when
  // arriving via the "book your return drop-off" prompt, so the rider isn't
  // forced to re-search an address they already searched once — otherwise
  // identical to a normal blank start (coords null until a suggestion is picked).
  const [pickupCoords, setPickupCoords] = useState(
    route?.params?.presetPickupLat != null && route?.params?.presetPickupLng != null
      ? { lat: route.params.presetPickupLat, lng: route.params.presetPickupLng }
      : null
  );
  const [stops, setStops] = useState([route?.params?.presetDestinationAddress || ""]);
  const [destinationCoords, setDestinationCoords] = useState(
    route?.params?.presetDestinationLat != null && route?.params?.presetDestinationLng != null
      ? { lat: route.params.presetDestinationLat, lng: route.params.presetDestinationLng }
      : null
  ); // coords for the LAST stop only — fare is priced pickup-to-final-destination
  const [vehicle, setVehicle] = useState("suv");
  const [bookingType, setBookingType] = useState(route?.params?.presetBookingType || "one_way");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [securityEscort, setSecurityEscort] = useState(false);
  const [fleetSize, setFleetSize] = useState(0); // 0 | 2 | 3
  const [luxury, setLuxury] = useState(false); // only meaningful for sedan/suv
  const [flightNumber, setFlightNumber] = useState(route?.params?.flightNumber || "");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");
  const linkedRideId = route?.params?.linkedRideId || null;

  // Airport Drop-off has no flight-landing event to anchor timing on, so
  // the rider tells us directly when they want picking up. Defaults to
  // tomorrow morning — a sensible starting point for a next-day departure,
  // never left ambiguous the way charter bookings' free-text date/time
  // fields are (see ChauffeurScreen) since this one is actually validated
  // and stored as a real timestamp server-side.
  const [scheduleDayOffset, setScheduleDayOffset] = useState(1); // 0 = today, 1 = tomorrow, ...
  const [scheduleHour, setScheduleHour] = useState("9"); // 0-23
  const [scheduleMinute, setScheduleMinute] = useState("00");

  // "Full Day" can be booked for any number of days — just type a number
  // and the fare is calculated on checkout accordingly. No chip picker, no
  // preset ceiling here; arrivo-backend/services/fare.js still enforces a
  // generous sanity-check upper bound server-side (see MAX_FULL_DAY_COUNT
  // there) purely to reject garbage input, not to steer riders elsewhere.
  // Defaults to 1 — "leave it as it is" needs no interaction at all.
  // Irrelevant for every other booking type.
  const [fullDayCount, setFullDayCount] = useState(1);
  const [fullDayCountInput, setFullDayCountInput] = useState("1");
  const setFullDayCountClamped = (n) => {
    const normalized = Math.max(Number.isFinite(n) ? Math.round(n) : 1, 1);
    setFullDayCount(normalized);
    setFullDayCountInput(String(normalized));
  };

  // Airline-style luggage entry: carry-on stays with the rider and never
  // affects vehicle choice; checked bags + the heavy/oversized flag are
  // what drive the auto-recommendation below (same convention as the
  // website's booking.js). Never sent to the backend or billed — this is
  // purely a UX helper for picking a vehicle, same as before.
  const [carryOnBags, setCarryOnBags] = useState("1");
  const [checkedBags, setCheckedBags] = useState("1");
  const [bulkyLuggage, setBulkyLuggage] = useState(false);
  // Once the rider taps a vehicle themselves, stop silently overriding
  // their choice — except if it becomes genuinely invalid (over capacity),
  // same rule the website already uses.
  const [vehicleManuallyPicked, setVehicleManuallyPicked] = useState(false);

  // The live server-computed quote — this, not any local math, is what
  // actually gets charged (the backend re-verifies it against this same
  // formula when the ride is created).
  const [quote, setQuote] = useState(null); // { fareNaira, distanceKm, durationMin } | null
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(null);
  const quoteDebounceRef = useRef(null);
  // See the quote-fetch effect below for what this guards against.
  const quoteRequestIdRef = useRef(0);

  const addStop = () => setStops((s) => [...s, ""]);
  const updateStop = (i, val) => {
    setStops((s) => s.map((v, idx) => (idx === i ? val : v)));
    if (i === stops.length - 1) setDestinationCoords(null); // typing invalidates the resolved destination
  };

  const destination = stops[stops.length - 1] || "";
  const excludedArea = useMemo(() => findExcludedArea(destination) || findExcludedArea(pickup), [destination, pickup]);
  const selectedBooking = BOOKING_TYPES.find((b) => b.id === bookingType);
  // Children take up a seat same as an adult does for capacity purposes —
  // matches the website's booking.js (passengers = adults + children
  // against MAX_PASSENGERS). Only adults has ever been collected here
  // until now; children was silently missing from the app entirely.
  const passengerCount = Math.max(1, (Number(adults) || 0) + (Number(children) || 0));
  const maxForVehicle = MAX_PASSENGERS[vehicle];
  // How many of the selected vehicle it actually takes to fit everyone —
  // e.g. 8 passengers in a 5-seat SUV needs 2 SUVs. No longer a hard stop;
  // the fare (see the quote effect below, and computeFare server-side)
  // scales with this instead of the booking being blocked outright.
  const vehicleCount = Math.max(1, Math.ceil(passengerCount / maxForVehicle));
  const needsMultipleVehicles = vehicleCount > 1;
  // Past MAX_AUTO_VEHICLE_COUNT vehicles, no driver pool can realistically
  // be matched for a single trip automatically — this is the one case that
  // still blocks booking, same as an excluded-area address.
  const groupTooLarge = vehicleCount > MAX_AUTO_VEHICLE_COUNT;
  // Both "one_way" (arrival pickup) and "dropoff" (airport drop-off) are
  // location-priced trips needing real coordinates — only the multi-day
  // charter types (full_day/week/month) skip this.
  const needsCoords = bookingType === "one_way" || bookingType === "dropoff";
  const coordsResolved = !needsCoords || (!!pickupCoords && !!destinationCoords);
  const recommendedVehicle = recommendVehicle(Number(checkedBags) || 0, bulkyLuggage, passengerCount);

  // Only "dropoff" needs an explicit scheduled time — "one_way" pickups are
  // driven by the flight-landing event instead (see needsFlightNumber
  // below), and charter bookings collect their own date/time separately.
  const needsScheduledTime = bookingType === "dropoff";
  const scheduledDateObj = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + scheduleDayOffset);
    d.setHours(Number(scheduleHour) || 0, Number(scheduleMinute) || 0, 0, 0);
    return d;
  }, [scheduleDayOffset, scheduleHour, scheduleMinute]);
  const scheduledTimeValid = !needsScheduledTime || scheduledDateObj.getTime() > Date.now();

  // Auto-select the recommended vehicle until the rider manually picks one
  // themselves. A manual pick is no longer abandoned just because the
  // passenger count exceeds THAT vehicle's single-vehicle capacity — it now
  // just books more than one of it (see vehicleCount above). Only bail back
  // to the recommendation if the manually-picked vehicle would need more
  // than MAX_AUTO_VEHICLE_COUNT of itself to fit everyone, since at that
  // point a bigger-capacity vehicle type genuinely means fewer vehicles.
  useEffect(() => {
    if (!vehicleManuallyPicked) {
      if (vehicle !== recommendedVehicle && passengerCount <= MAX_PASSENGERS[recommendedVehicle]) {
        setVehicle(recommendedVehicle);
      }
      return;
    }
    if (Math.ceil(passengerCount / MAX_PASSENGERS[vehicle]) > MAX_AUTO_VEHICLE_COUNT) {
      setVehicleManuallyPicked(false);
      setVehicle(recommendedVehicle);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedVehicle, passengerCount, vehicleManuallyPicked, vehicle]);

  // Re-fetch a fare quote whenever anything that affects price changes.
  // Debounced so switching vehicle/add-ons rapidly doesn't fire a request
  // per click, and — for one-way trips — only fires once both addresses
  // have resolved real coordinates (typing alone never triggers billed
  // Distance Matrix calls, only picking a suggestion does).
  //
  // quoteRequestIdRef guards against a real race condition: clearTimeout
  // above only cancels a request that hasn't fired its network call yet —
  // if an OLDER request is already in flight (awaiting getFareQuote) when
  // something changes again, nothing stops it from resolving AFTER the
  // newer request and overwriting a fresh, correct quote with its own
  // stale result (or a stale error, e.g. "vehicleType is required" from a
  // moment before the vehicle had actually settled — reported as the quote
  // error sticking around even after picking a valid vehicle). Each
  // request captures the id current when IT started; only the response
  // whose id still matches the ref when it resolves is allowed to touch
  // state, so a late-arriving stale response is simply discarded.
  useEffect(() => {
    clearTimeout(quoteDebounceRef.current);
    quoteRequestIdRef.current += 1;
    const requestId = quoteRequestIdRef.current;
    setQuote(null);
    setQuoteError(null);

    if (needsCoords && !coordsResolved) return; // nothing to quote yet
    // overCapacity no longer blocks the quote — a bigger group just prices
    // as multiple vehicles (see vehicleCount/adults/children in payload
    // below). groupTooLarge is the one passenger-related case that still
    // blocks, same as an excluded-area address.
    if (excludedArea || groupTooLarge) return;

    setQuoteLoading(true);
    quoteDebounceRef.current = setTimeout(async () => {
      try {
        const payload = {
          bookingType, vehicleType: vehicle, securityEscort, fleetSize,
          luxury: luxury && (vehicle === "sedan" || vehicle === "suv"),
          durationDays: bookingType === "full_day" ? fullDayCount : selectedBooking.days,
          // The backend re-derives vehicleCount from these two (never
          // trusts a client-sent count) and scales the fare accordingly —
          // see arrivo-backend/services/fare.js computeVehicleCount.
          adults: Number(adults) || 1,
          children: Number(children) || 0,
        };
        if (needsCoords) {
          // pickupAddress/destinationAddress are what actually price a
          // one-way trip now (flat per-location fare, see
          // arrivo-backend/services/fare.js) — lat/lng are sent too, but
          // only used server-side for an informational distance/duration
          // display, never for the fare itself.
          payload.pickupAddress = pickup;
          payload.destinationAddress = destination;
          payload.pickupLat = pickupCoords.lat;
          payload.pickupLng = pickupCoords.lng;
          payload.destinationLat = destinationCoords.lat;
          payload.destinationLng = destinationCoords.lng;
        }
        const result = await getFareQuote(token, payload);
        if (quoteRequestIdRef.current !== requestId) return; // a newer request has already superseded this one
        setQuote(result);
      } catch (e) {
        if (quoteRequestIdRef.current !== requestId) return;
        setQuoteError(e.message || "Couldn't calculate a fare for this trip. Please try again.");
      } finally {
        if (quoteRequestIdRef.current === requestId) setQuoteLoading(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(quoteDebounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingType, vehicle, securityEscort, fleetSize, luxury, fullDayCount, pickupCoords, destinationCoords, excludedArea, groupTooLarge, adults, children]);

  // Flight number is required for one-way airport pickups — it's the only
  // way to actually track the rider's flight and get a real ETA (see
  // TrackingScreen, which fetches live flight status from it). Not
  // required for charter/Chauffeur bookings, which aren't tied to a flight.
  const needsFlightNumber = bookingType === "one_way";

  const canConfirm =
    !excludedArea && !groupTooLarge && pickup.trim().length > 0 && destination.trim().length > 0 &&
    (!needsFlightNumber || flightNumber.trim().length > 0) &&
    scheduledTimeValid &&
    coordsResolved && !!quote && !quoteLoading;

  const confirm = () => {
    if (!canConfirm) return;
    navigation.navigate("Checkout", {
      amountNaira: quote.fareNaira,
      distanceKm: quote.distanceKm,
      durationMin: quote.durationMin,
      label: `${VEHICLES.find((v) => v.id === vehicle).label}${needsMultipleVehicles ? ` × ${vehicleCount}` : ""}. ${selectedBooking.label}${bookingType === "full_day" && fullDayCount > 1 ? ` × ${fullDayCount} days` : ""}`,
      pickupAddress: pickup,
      stops,
      flightNumber: flightNumber.trim() || undefined,
      vehicleType: vehicle,
      bookingType: selectedBooking.id,
      durationDays: bookingType === "full_day" ? fullDayCount : selectedBooking.days,
      adults: Number(adults) || 1,
      children: Number(children) || 0,
      securityEscort,
      fleetSize,
      luxury: luxury && (vehicle === "sedan" || vehicle === "suv"),
      emergencyContactName: emergencyContactName.trim() || undefined,
      emergencyContactPhone: emergencyContactPhone.trim() || undefined,
      pickupLat: pickupCoords?.lat,
      pickupLng: pickupCoords?.lng,
      destinationLat: destinationCoords?.lat,
      destinationLng: destinationCoords?.lng,
      scheduledPickupAt: needsScheduledTime ? scheduledDateObj.toISOString() : undefined,
      linkedRideId: linkedRideId || undefined,
    });
  };

  return (
    <View style={styles.screen}>
      <GradientBackground variant="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Set your route</Text>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Booking type</Text>
          <View style={styles.bookingRow}>
            {BOOKING_TYPES.map((b) => (
              <Pressable
                key={b.id}
                onPress={() => setBookingType(b.id)}
                style={[styles.bookingChip, bookingType === b.id && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, bookingType === b.id && styles.bookingChipTextActive]}>{b.label}</Text>
              </Pressable>
            ))}
          </View>
          {bookingType === "full_day" ? (
            <View style={{ marginTop: spacing.sm }}>
              <Text style={styles.meta}>Number of days</Text>
              <TextInput
                style={[styles.input, { marginTop: 6 }]}
                value={fullDayCountInput}
                onChangeText={(text) => {
                  setFullDayCountInput(text.replace(/[^0-9]/g, ""));
                }}
                onEndEditing={() => setFullDayCountClamped(Number(fullDayCountInput))}
                placeholder="1"
                placeholderTextColor={colors.dark.textMuted}
                keyboardType="number-pad"
              />
            </View>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.stopRow}>
            <View style={[styles.dot, { backgroundColor: colors.tealBright }]} />
            <AddressAutocomplete
              style={{ flex: 1 }}
              inputStyle={styles.stopInput}
              value={pickup}
              onChangeText={setPickup}
              onSelect={(resolved) => setPickupCoords(resolved)}
              placeholder="Pickup address"
            />
          </View>
          {stops.map((stop, i) => (
            <View key={i} style={styles.stopRow}>
              <View style={styles.thread} />
              <View style={[styles.dot, { backgroundColor: i === stops.length - 1 ? colors.coral : colors.amber }]} />
              {i === stops.length - 1 ? (
                <AddressAutocomplete
                  style={{ flex: 1 }}
                  inputStyle={styles.stopInput}
                  value={stop}
                  onChangeText={(v) => updateStop(i, v)}
                  onSelect={(resolved) => setDestinationCoords(resolved)}
                  placeholder="Destination"
                />
              ) : (
                <TextInput
                  style={styles.stopInput}
                  value={stop}
                  onChangeText={(v) => updateStop(i, v)}
                  placeholder={`Stop ${i + 1}`}
                  placeholderTextColor={colors.dark.textMuted}
                />
              )}
            </View>
          ))}
          <Pressable onPress={addStop} style={styles.addStop}>
            <Ionicons name="add-circle-outline" size={16} color={colors.tealBright} />
            <Text style={styles.addStopText}>Add destination</Text>
          </Pressable>
        </Card>

        {needsCoords && pickup.trim() && destination.trim() && !coordsResolved ? (
          <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: colors.amber, borderWidth: 1 }}>
            <Text style={styles.hintText}>
              Tap one of the suggested addresses that appears under pickup/destination as you type — typing an
              address without selecting a suggestion won't let us calculate your fare or confirm the booking.
            </Text>
          </Card>
        ) : null}

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Flight number{needsFlightNumber ? "" : " (optional)"}</Text>
          {needsFlightNumber ? (
            <Text style={styles.addonNote}>
              Required — this is how we track your flight and know your real arrival time.
            </Text>
          ) : bookingType === "dropoff" ? (
            <Text style={styles.addonNote}>
              Lets us keep an eye on delays that might affect your pickup time.
            </Text>
          ) : null}
          <TextInput
            style={styles.flightInput}
            value={flightNumber}
            onChangeText={(v) => setFlightNumber(v.toUpperCase())}
            placeholder="e.g. BA075"
            placeholderTextColor={colors.dark.textMuted}
            autoCapitalize="characters"
          />
        </Card>

        {needsScheduledTime ? (
          <Card tone="dark" style={{ marginBottom: spacing.md }}>
            <Text style={styles.cardLabel}>Pickup time</Text>
            <Text style={styles.addonNote}>
              When should we pick you up for the airport? There's no flight to track here, so we go by the time you set.
            </Text>
            <View style={{ height: 8 }} />
            <View style={styles.bookingRow}>
              {[0, 1, 2, 3, 4, 5, 6].map((offset) => (
                <Pressable
                  key={offset}
                  onPress={() => setScheduleDayOffset(offset)}
                  style={[styles.bookingChip, scheduleDayOffset === offset && styles.bookingChipActive]}
                >
                  <Text style={[styles.bookingChipText, scheduleDayOffset === offset && styles.bookingChipTextActive]}>
                    {scheduleDayLabel(offset)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={{ height: 10 }} />
            <View style={styles.stopRow}>
              <Text style={styles.passengerLabel}>Hour (0-23)</Text>
              <TextInput
                style={styles.passengerInput}
                value={scheduleHour}
                onChangeText={setScheduleHour}
                keyboardType="number-pad"
                maxLength={2}
                placeholderTextColor={colors.dark.textMuted}
              />
            </View>
            <View style={{ height: 6 }} />
            <Text style={styles.passengerLabel}>Minute</Text>
            <View style={[styles.bookingRow, { marginTop: 6 }]}>
              {SCHEDULE_MINUTES.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setScheduleMinute(m)}
                  style={[styles.bookingChip, scheduleMinute === m && styles.bookingChipActive]}
                >
                  <Text style={[styles.bookingChipText, scheduleMinute === m && styles.bookingChipTextActive]}>:{m}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={[styles.addonNote, { marginTop: 8 }]}>
              Pickup: {scheduleDayLabel(scheduleDayOffset)} at {String(Number(scheduleHour) || 0).padStart(2, "0")}:{scheduleMinute}
            </Text>
            {!scheduledTimeValid ? (
              <Text style={styles.warningText}>Please choose a pickup time in the future.</Text>
            ) : null}
          </Card>
        ) : null}

        {excludedArea ? (
          <Card tone="dark" style={{ marginBottom: spacing.md, borderColor: colors.coral, borderWidth: 1 }}>
            <Text style={styles.warningText}>
              We don't currently operate in {excludedArea.name}. Please choose a different pickup or destination.
            </Text>
          </Card>
        ) : null}

        <LiveMap
          pickup={pickupCoords ? { ...pickupCoords, label: "Pickup" } : null}
          destination={destinationCoords ? { ...destinationCoords, label: "Destination" } : null}
          etaLabel={quote ? `ETA ~${Math.round(quote.durationMin)} min` : "ETA —"}
          distanceLabel={
            quote && quote.distanceKm != null
              ? `${stops.length} stop${stops.length > 1 ? "s" : ""} · ${quote.distanceKm.toFixed(1)}km`
              : undefined
          }
        />

        <Card tone="dark" style={{ marginTop: spacing.md, marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Passengers</Text>
          <View style={styles.stopRow}>
            <Text style={styles.passengerLabel}>Adults</Text>
            <TextInput
              style={styles.passengerInput}
              value={adults}
              onChangeText={setAdults}
              keyboardType="number-pad"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          <View style={styles.stopRow}>
            <Text style={styles.passengerLabel}>Children</Text>
            <TextInput
              style={styles.passengerInput}
              value={children}
              onChangeText={setChildren}
              keyboardType="number-pad"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          {groupTooLarge ? (
            <Text style={styles.warningText}>
              {passengerCount} passengers is more than we can automatically match to vehicles (up to {MAX_AUTO_VEHICLE_COUNT * maxForVehicle} in {VEHICLES.find((v) => v.id === vehicle).label}s). Please contact RideArrivo directly to arrange a larger group booking.
            </Text>
          ) : needsMultipleVehicles ? (
            <Text style={styles.hintText}>
              This vehicle fits up to {maxForVehicle} — we'll book {vehicleCount} × {VEHICLES.find((v) => v.id === vehicle).label} to fit all {passengerCount} passengers, and the fare covers all {vehicleCount}.
            </Text>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Luggage</Text>
          <View style={styles.stopRow}>
            <Text style={styles.passengerLabel}>Carry-on bags</Text>
            <TextInput
              style={styles.passengerInput}
              value={carryOnBags}
              onChangeText={setCarryOnBags}
              keyboardType="number-pad"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          <View style={styles.stopRow}>
            <Text style={styles.passengerLabel}>Checked bags</Text>
            <TextInput
              style={styles.passengerInput}
              value={checkedBags}
              onChangeText={setCheckedBags}
              keyboardType="number-pad"
              placeholderTextColor={colors.dark.textMuted}
            />
          </View>
          <View style={[styles.toggleRow, { marginTop: 6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.addonNote}>
                One or more checked bags is heavy or oversized (over 32kg, a large duffel, cooler, sports or musical equipment, etc.)
              </Text>
            </View>
            <Switch
              value={bulkyLuggage}
              onValueChange={setBulkyLuggage}
              trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
            />
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Choose a vehicle</Text>
          {VEHICLES.map((v) => {
            // A vehicle is only actually unselectable if even multiplying it
            // (see vehicleCount above) can't realistically fit the group —
            // otherwise it just books more than one, so every vehicle stays
            // tappable regardless of passenger count.
            const neededForThisVehicle = Math.max(1, Math.ceil(passengerCount / MAX_PASSENGERS[v.id]));
            const tooSmall = neededForThisVehicle > MAX_AUTO_VEHICLE_COUNT;
            return (
              <Pressable
                key={v.id}
                onPress={() => {
                  if (tooSmall) return;
                  setVehicleManuallyPicked(true);
                  setVehicle(v.id);
                }}
                style={[styles.vehicleRow, tooSmall && { opacity: 0.4 }]}
                disabled={tooSmall}
              >
                <View>
                  <Text style={[styles.vehicleLabel, vehicle === v.id && { color: colors.amber }]}>
                    {vehicle === v.id ? "● " : "○ "}
                    {v.label}
                  </Text>
                  <Text style={styles.vehicleCapacity}>
                    Fits up to {MAX_PASSENGERS[v.id]} passengers
                    {neededForThisVehicle > 1 ? ` · needs ${neededForThisVehicle} for your group` : ""}
                    {v.id === "pickup" ? " · best for heavy or bulky luggage" : ""}
                    {!tooSmall && neededForThisVehicle === 1 && recommendedVehicle === v.id ? " · Recommended for your luggage" : ""}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {vehicle === "sedan" || vehicle === "suv" ? (
            <View style={[styles.toggleRow, { marginTop: 6 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>Luxury</Text>
                <Text style={styles.addonNote}>
                  Nicer {vehicle === "sedan" ? "Sedan" : "SUV"} for this trip — adds ${LUXURY_LABEL_USD[vehicle]} equivalent
                </Text>
              </View>
              <Switch
                value={luxury}
                onValueChange={setLuxury}
                trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
              />
            </View>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>Security escort</Text>
              <Text style={styles.addonNote}>Adds a dedicated security vehicle</Text>
            </View>
            <Switch
              value={securityEscort}
              onValueChange={setSecurityEscort}
              trackColor={{ false: "rgba(255,255,255,0.18)", true: colors.amber }}
            />
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Fleet accompaniment</Text>
          <View style={styles.bookingRow}>
            {[0, 2, 3].map((n) => (
              <Pressable
                key={n}
                onPress={() => setFleetSize(n)}
                style={[styles.bookingChip, fleetSize === n && styles.bookingChipActive]}
              >
                <Text style={[styles.bookingChipText, fleetSize === n && styles.bookingChipTextActive]}>
                  {n === 0 ? "None" : `${n} vehicles`}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.cardLabel}>Emergency contact (optional)</Text>
          <Text style={styles.addonNote}>Someone we can reach if we can't reach you during this ride.</Text>
          <View style={{ height: 6 }} />
          <TextInput
            style={styles.flightInput}
            value={emergencyContactName}
            onChangeText={setEmergencyContactName}
            placeholder="Contact name"
            placeholderTextColor={colors.dark.textMuted}
          />
          <View style={{ height: 8 }} />
          <TextInput
            style={styles.flightInput}
            value={emergencyContactPhone}
            onChangeText={setEmergencyContactPhone}
            placeholder="Contact phone number"
            placeholderTextColor={colors.dark.textMuted}
            keyboardType="phone-pad"
          />
        </Card>

        {!pickup.trim() || !destination.trim() ? (
          <Text style={styles.warningText}>Enter a pickup address and destination to continue.</Text>
        ) : needsFlightNumber && !flightNumber.trim() ? (
          <Text style={styles.warningText}>Enter your flight number so we can track your arrival.</Text>
        ) : !scheduledTimeValid ? (
          <Text style={styles.warningText}>Please choose a pickup time in the future.</Text>
        ) : quoteError ? (
          <Text style={styles.warningText}>{quoteError}</Text>
        ) : null}

        <View style={{ height: spacing.lg }} />
        {quoteLoading ? (
          <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
            <ActivityIndicator color={colors.amber} />
            <Text style={styles.quotingText}>Calculating your fare…</Text>
          </View>
        ) : (
          <Button
            label={quote ? `Confirm · ${formatFare(quote.fareNaira)}${!isNigeria ? ` (₦${quote.fareNaira.toLocaleString()})` : ""}` : "Confirm"}
            disabled={!canConfirm}
            trailingIcon
            onPress={confirm}
          />
        )}
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  title: { fontSize: 18, fontWeight: "700", color: colors.dark.text, marginBottom: spacing.md },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  thread: { width: 2, height: 16, backgroundColor: "rgba(255,255,255,0.25)", marginLeft: 3.5 },
  stopInput: { color: colors.dark.text, fontSize: 13, paddingVertical: 6 },
  addStop: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 18, marginTop: 4 },
  addStopText: { color: colors.tealBright, fontSize: 12, fontWeight: "600" },
  hintText: { color: colors.amber, fontSize: 11, marginTop: 8, marginLeft: 18, lineHeight: 15 },
  cardLabel: { color: colors.dark.text, fontWeight: "600", fontSize: 12, marginBottom: 8 },
  flightInput: {
    backgroundColor: colors.dark.fieldBg,
    color: colors.dark.text,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 13,
  },
  bookingRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bookingChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.dark.surfaceBorder,
  },
  bookingChipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  bookingChipText: { color: colors.dark.text, fontSize: 12, fontWeight: "600" },
  bookingChipTextActive: { color: colors.ink },
  vehicleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.dark.hairline,
  },
  vehicleLabel: { color: colors.dark.text, fontSize: 13 },
  vehicleCapacity: { color: colors.dark.textMuted, fontSize: 10.5, marginTop: 2, marginLeft: 14 },
  passengerLabel: { color: colors.dark.text, fontSize: 13, flex: 1 },
  passengerInput: {
    color: colors.dark.text, fontSize: 14, fontWeight: "700", width: 60, textAlign: "center",
    backgroundColor: colors.dark.fieldBg, borderRadius: 8, paddingVertical: 6,
  },
  toggleRow: { flexDirection: "row", alignItems: "center" },
  addonNote: { color: colors.dark.textMuted, fontSize: 11, marginTop: 2 },
  warningText: { color: "#FF9B8A", fontSize: 11.5, marginTop: 6, lineHeight: 16 },
  quotingText: { color: colors.dark.textMuted, fontSize: 12, marginTop: 6 },
});
