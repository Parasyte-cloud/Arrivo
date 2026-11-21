import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { useAuth } from "./AuthContext";
import { getMyTiers } from "../services/api";
import { pickTier } from "../utils/tiers";

// The services this driver can work, and which one the Dashboard is showing.
// The owner (or someone the owner named) switches services on in ArrivoOps; the
// app only reads that. If the server has no tiers yet (an older backend) the
// app behaves exactly as before: legacy is true and nothing is hidden.

const SAVED_KEY = "ra.driver.tier";
const TiersContext = createContext(null);

export function TiersProvider({ children }) {
  const { token, isAuthenticated } = useAuth();
  const [tiers, setTiers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [saved, setSaved] = useState(null);
  const lastLoad = useRef(0);

  useEffect(() => {
    AsyncStorage.getItem(SAVED_KEY).then((v) => v && setSaved(v)).catch(() => {});
  }, []);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const r = await getMyTiers(token);
      setTiers(r.tiers || []);
      setLegacy(false);
      lastLoad.current = Date.now();
    } catch (e) {
      // 404 means no driver profile yet, 401 is handled by sign-out. Anything
      // else (an old backend with no route, or no signal) must not lock a
      // driver out, so the screen falls back to how it worked before.
      if (!e || e.status !== 401) setLegacy(true);
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) reload();
    else { setTiers([]); setLoaded(false); setLegacy(false); }
  }, [isAuthenticated, reload]);

  // A change Ops makes should reach the driver without reinstalling or signing out.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && isAuthenticated && Date.now() - lastLoad.current > 30000) reload();
    });
    return () => sub.remove();
  }, [isAuthenticated, reload]);

  const active = useMemo(() => tiers.filter((t) => t.status === "active").map((t) => t.slug), [tiers]);
  const current = legacy ? null : pickTier(active, saved);

  const select = useCallback((slug) => {
    setSaved(slug);
    AsyncStorage.setItem(SAVED_KEY, slug).catch(() => {});
  }, []);

  const value = useMemo(() => ({ tiers, active, current, select, reload, loaded, legacy }), [tiers, active, current, select, reload, loaded, legacy]);
  return <TiersContext.Provider value={value}>{children}</TiersContext.Provider>;
}

export function useTiers() {
  const ctx = useContext(TiersContext);
  if (!ctx) throw new Error("useTiers must be used inside TiersProvider");
  return ctx;
}
