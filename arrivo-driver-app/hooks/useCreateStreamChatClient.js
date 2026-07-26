import { useEffect, useState } from "react";
import { StreamChat } from "stream-chat-expo";
import { useAuth } from "../context/AuthContext";
import { getCallToken } from "../services/api";

// Builds (and connects) a Stream Chat client for the current user, mirroring
// hooks/useCreateStreamVideoClient.js's shape but for the separate Chat
// product. Unlike calling, chat has no background/push-driven client
// construction path to stay in sync with — the chat screen is only ever
// opened from inside the app while the driver is already signed in, so a
// single plain client (no getOrCreateInstance singleton) is enough here.
export function useCreateStreamChatClient() {
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
        const auth = await getCallToken(token);
        if (cancelled) return;

        instance = StreamChat.getInstance(auth.apiKey);
        await instance.connectUser({ id: auth.userId, name: user.name }, auth.chatToken);
        if (cancelled) {
          await instance.disconnectUser().catch(() => {});
          return;
        }
        setClient(instance);
      } catch (e) {
        // Non-fatal — chat just won't be available this session until the
        // driver re-opens the chat screen. Never blocks the rest of the
        // app on a chat-setup failure.
        console.error("Could not set up chat:", e.message);
      }
    })();

    return () => {
      cancelled = true;
      if (instance) instance.disconnectUser().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token, user?.id]);

  return client;
}
