import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import {
  OverlayProvider,
  Chat,
  Channel,
  MessageList,
  MessageInput,
} from "stream-chat-expo";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../context/AuthContext";
import { useCreateStreamChatClient } from "../hooks/useCreateStreamChatClient";
import { getRideChatChannel } from "../services/api";
import { colors, spacing } from "../theme/tokens";

// Opened from TrackingScreen's "Message driver" button. Gets-or-creates the
// ride-scoped channel server-side (see arrivo-backend/routes/chat.js) on
// mount, then hands it to Stream's own prebuilt Channel/MessageList/
// MessageInput components — no custom message rendering needed.
export default function ChatScreen({ route }) {
  const { rideId } = route?.params || {};
  const { token } = useAuth();
  const chatClient = useCreateStreamChatClient();
  const [channel, setChannel] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!chatClient || !rideId) return;

    (async () => {
      try {
        const { channelId } = await getRideChatChannel(token, rideId);
        if (cancelled) return;
        const c = chatClient.channel("messaging", channelId);
        await c.watch();
        if (cancelled) return;
        setChannel(c);
      } catch (e) {
        if (!cancelled) setError(e.message || "Could not open chat.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chatClient, rideId, token]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!chatClient || !channel) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.amber} size="large" />
      </View>
    );
  }

  return (
    <OverlayProvider>
      <Chat client={chatClient}>
        <Channel channel={channel}>
          <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
            <MessageList />
            <MessageInput />
          </SafeAreaView>
        </Channel>
      </Chat>
    </OverlayProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.dark.bg0, padding: spacing.lg },
  errorText: { color: colors.dark.text, textAlign: "center" },
});
