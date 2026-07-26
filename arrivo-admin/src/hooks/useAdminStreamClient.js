import { useEffect, useState } from "react";
import { StreamVideoClient } from "@stream-io/video-react-sdk";
import { useAuth } from "../AuthContext";
import { getCallToken } from "../api";

// Lazily builds ONE Stream Video client for the admin's session, reused by
// every "Call" button on every page (Riders, Drivers, …) rather than each
// button constructing its own. Admin/support accounts only ever PLACE
// outbound calls here — they never receive one — so there's no ringing/
// CallKit/push setup needed at all, unlike the mobile apps: just a plain
// web client that can call client.call(type, id).getOrCreate({ring: true}).
//
// Same /api/calls/token endpoint the mobile apps use — it's role-agnostic,
// keyed purely on the signed-in user's id, and admins/support staff share
// the same `users` table/id-space as riders and drivers (see db/schema.sql),
// so this needs no admin-specific backend work.
//
// IMPORTANT: uses getOrCreateInstance (same as every mobile hook in this
// codebase), NOT `new StreamVideoClient()`. Two admins can share the same
// browser/computer across a logout+login without a full page reload (the
// login form just swaps React state) — a plain cached instance keyed only
// on "does one exist yet" would keep calling as the FIRST admin's Stream
// identity forever. getOrCreateInstance is Stream's own SDK mechanism for
// this exact situation: passing a different `user.id` makes it disconnect
// the previous session and connect the new one under the hood.
export function useAdminStreamClient() {
  const { token, user, isAuthenticated } = useAuth();
  const [client, setClient] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    if (!isAuthenticated || !token || !user) {
      setClient(null);
      return;
    }

    (async () => {
      try {
        const auth = await getCallToken(token);
        if (cancelled) return;
        const instance = StreamVideoClient.getOrCreateInstance({
          apiKey: auth.apiKey,
          user: { id: auth.userId, name: user.name },
          token: auth.videoToken,
        });
        setClient(instance);
      } catch (e) {
        if (!cancelled) setError(e.message || "Could not set up calling.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, token, user?.id]);

  return { client, error };
}
