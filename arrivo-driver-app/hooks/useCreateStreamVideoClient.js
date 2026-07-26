import { useEffect, useState } from "react";
import { StreamVideoClient } from "@stream-io/video-react-native-sdk";
import { useAuth } from "../context/AuthContext";
import { getCallToken } from "../services/api";

// Sets up (or reuses, via getOrCreateInstance) the same Stream Video
// client instance that utils/setPushConfig.js's createStreamVideoClient
// creates for the background/push path — reusing the singleton is what
// lets a call accepted/declined from the lock screen stay in sync with
// the in-app UI once the app comes to the foreground.
//
// Named "useCreateStreamVideoClient" (not "useStreamVideoClient") to avoid
// colliding with the SDK's OWN useStreamVideoClient() hook, which any
// screen inside <StreamVideo> (see components/CallOverlay.js) uses to grab
// the already-constructed client from context in order to start an
// outgoing call — that's a different thing from this hook, which only
// exists to build the client once, right after login.
//
// Tracks the singleton instance handed back by getOrCreateInstance so it can
// be disconnected explicitly from context/AuthContext.js's logout(), same as
// StreamVideoRN.onPushLogout() is already called there for the push side —
// logout can't rely on this hook's own effect cleanup alone, since that only
// runs once React gets around to re-rendering with isAuthenticated false,
// which can lag behind logout()'s own SecureStore/token clearing. Left
// connected, getOrCreateInstance's singleton (keyed by apiKey+user) would
// still be live under the outgoing driver's identity, so if a second driver
// logs into the same device next, the client could hand back — or ring —
// under the wrong identity. Mirrors the disconnect-on-cleanup pattern
// hooks/useCreateStreamChatClient.js already uses for the chat client.
let activeInstance = null;

export async function disconnectStreamVideoClient() {
  const instance = activeInstance;
  activeInstance = null;
  if (instance) await instance.disconnectUser().catch(() => {});
}

export function useCreateStreamVideoClient() {
  const { token, user, isAuthenticated } = useAuth();
  const [client, setClient] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let instance = null;

    if (!isAuthenticated || !token || !user) {
      setClient(null);
      return;
    }

    (async () => {
      try {
        const first = await getCallToken(token);
        if (cancelled) return;

        const tokenProvider = async () => {
          const fresh = await getCallToken(token);
          return fresh.videoToken;
        };

        instance = StreamVideoClient.getOrCreateInstance({
          apiKey: first.apiKey,
          user: { id: first.userId, name: user.name },
          tokenProvider,
          options: { rejectCallWhenBusy: true },
        });
        activeInstance = instance;
        if (cancelled) {
          await instance.disconnectUser().catch(() => {});
          if (activeInstance === instance) activeInstance = null;
          return;
        }
        setClient(instance);
      } catch (e) {
        // Non-fatal — calling just won't be available this session until
        // the next successful token fetch (e.g. next login, or the driver
        // backs out and back into the app). Never blocks the rest of the
        // app on a calling-setup failure.
        console.error("Could not set up calling:", e.message);
      }
    })();

    return () => {
      cancelled = true;
      if (instance) {
        instance.disconnectUser().catch(() => {});
        if (activeInstance === instance) activeInstance = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token, user?.id]);

  return client;
}
