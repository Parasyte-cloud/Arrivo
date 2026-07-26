import { useEffect, useRef, useState } from "react";
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
let clientPromise = null;

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

    if (!clientPromise) {
      clientPromise = (async () => {
        const auth = await getCallToken(token);
        const instance = new StreamVideoClient({
          apiKey: auth.apiKey,
          user: { id: auth.userId, name: user.name },
          token: auth.videoToken,
        });
        return instance;
      })();
    }

    clientPromise
      .then((instance) => {
        if (!cancelled) setClient(instance);
      })
      .catch((e) => {
        clientPromise = null; // let the next attempt retry from scratch
        if (!cancelled) setError(e.message || "Could not set up calling.");
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, token, user?.id]);

  return { client, error };
}
