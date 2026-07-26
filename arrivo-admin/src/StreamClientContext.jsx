import { createContext, useContext } from "react";
import { useAdminStreamClient } from "./hooks/useAdminStreamClient";

// Single shared Stream Video client for the whole authenticated app, built
// once here instead of once per <CallButton/> — RidersPage/DriversPage
// render a CallButton per table row, so without this every single row
// would independently call useAdminStreamClient() and fire its own
// /api/calls/token request (N simultaneous requests for N rows). Wrapping
// the dashboard in <StreamClientProvider> hoists that single token
// fetch/client instance above all of them; every CallButton just reads it
// via useStreamClient() instead of building its own.
const StreamClientContext = createContext(null);

export function StreamClientProvider({ children }) {
  const value = useAdminStreamClient();
  return <StreamClientContext.Provider value={value}>{children}</StreamClientContext.Provider>;
}

export function useStreamClient() {
  const ctx = useContext(StreamClientContext);
  if (!ctx) throw new Error("useStreamClient must be used inside a StreamClientProvider");
  return ctx;
}
