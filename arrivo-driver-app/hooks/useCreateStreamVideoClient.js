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
export function useCreateStreamVideoClient() {
  const { token, user, isAuthenticated } = useAuth();
  const [client, setClient] = useState(null);

  useEffect(() => {
    let cancelled = false;

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
          return fresh.token;
        };

        const instance = StreamVideoClient.getOrCreateInstance({
          apiKey: first.apiKey,
          user: { id: first.userId, name: user.name },
          tokenProvider,
          options: { rejectCallWhenBusy: true },
        });
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token, user?.id]);

  return client;
}
