import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDriverDashboard, initializeSubscriptionPayment, verifySubscriptionPayment } from "../services/api";
import { isExpired, isPlausibleReference } from "../tiers/dashboard";

const PENDING_KEY = "arrivo_driver_pending_subscription_ref";

// Loads the dashboard numbers and runs the daily subscription payment.
//
// Paying: ask Paystack for a checkout link, open it, and when the driver comes
// back to the app confirm the payment with our server. The reference is saved
// first, so if the app is closed before it can confirm, the next open finishes
// the job and the driver is never charged without getting their day.
export function useSubscription(token, email) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const confirming = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await getDriverDashboard(token);
      if (!mounted.current) return d;
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      if (mounted.current) setError(e.message);
      return null;
    }
  }, [token]);

  // Confirm a saved payment, if there is one. Safe to call any time: the server
  // ignores a reference it has already applied.
  const confirmPending = useCallback(async () => {
    if (confirming.current) return;
    let ref = null;
    try { ref = await AsyncStorage.getItem(PENDING_KEY); } catch (_) { return; }
    if (!isPlausibleReference(ref)) {
      if (ref) AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
      return;
    }
    confirming.current = true;
    try {
      await verifySubscriptionPayment(token, ref);
      await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
      if (mounted.current) setError(null);
    } catch (e) {
      // Not paid (yet) is normal when the driver backed out of checkout.
      // Anything the server has settled for good clears the saved reference.
      if (e.status === 400 || e.status === 409) {
        await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
        if (e.code === "ALREADY_SUBSCRIBED" && mounted.current) setError(null);
        else if (mounted.current && e.status === 409) setError(e.message);
      }
    } finally {
      confirming.current = false;
      await load();
    }
  }, [token, load]);

  useEffect(() => {
    (async () => {
      await confirmPending();
      await load();
    })();
  }, [confirmPending, load]);

  // Coming back from the checkout page, or reopening the app: confirm and refresh.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") confirmPending();
    });
    return () => sub.remove();
  }, [confirmPending]);

  // A once-a-minute clock keeps "time left" honest. When the day ends the
  // dashboard is asked again, so the screen flips to "subscribe" at 12am.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const expired = data ? isExpired(data.subscription, now) : false;
  useEffect(() => {
    if (expired) load();
  }, [expired, load]);

  const subscribe = useCallback(async () => {
    if (paying) return;
    setPaying(true);
    setError(null);
    try {
      const price = data && data.subscription ? data.subscription.priceNaira : 2000;
      const { authorizationUrl, reference } = await initializeSubscriptionPayment(token, email, price);
      if (!isPlausibleReference(reference)) throw new Error("Could not start the payment. Please try again.");
      await AsyncStorage.setItem(PENDING_KEY, reference);
      await Linking.openURL(authorizationUrl);
    } catch (e) {
      if (mounted.current) setError(e.message || "Could not start the payment. Please try again.");
    } finally {
      if (mounted.current) setPaying(false);
    }
  }, [paying, data, token, email]);

  return { data, error, paying, now, reload: load, subscribe };
}
