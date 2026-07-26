import React from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  StreamVideo,
  StreamCall,
  useCalls,
  useCallStateHooks,
  CallingState,
  RingingCallContent,
  CallContent,
} from "@stream-io/video-react-native-sdk";
import { useCreateStreamVideoClient } from "../hooks/useCreateStreamVideoClient";

// Renders whatever call is currently ringing or active over the ENTIRE
// app, regardless of which screen is on top — this is deliberate (see
// Stream's own docs): a call can start from a push notification while the
// driver is anywhere in the app (or the app was just woken from a killed
// state by one), so this can't live inside a single screen/stack.
// shouldRejectCallWhenBusy (set in utils/setPushConfig.js and here) means
// there's only ever at most one call in this list in practice.
function CallUI() {
  const { useCallCallingState } = useCallStateHooks();
  const callingState = useCallCallingState();

  if (callingState === CallingState.RINGING) {
    return (
      <SafeAreaView style={StyleSheet.absoluteFill}>
        <RingingCallContent />
      </SafeAreaView>
    );
  }

  if (callingState === CallingState.JOINED || callingState === CallingState.JOINING) {
    return (
      <SafeAreaView style={StyleSheet.absoluteFill}>
        <CallContent />
      </SafeAreaView>
    );
  }

  return null;
}

function ActiveCalls() {
  const calls = useCalls();
  const call = calls[0];
  if (!call) return null;

  return (
    <StreamCall call={call}>
      <CallUI />
    </StreamCall>
  );
}

// Wraps the whole app (see App.js). Renders `children` untouched until the
// Stream client is ready (right after login) — nothing about normal app
// navigation depends on calling being set up, so this never blocks or
// delays anything else.
export function CallOverlayProvider({ children }) {
  const client = useCreateStreamVideoClient();

  if (!client) return children;

  return (
    <StreamVideo client={client}>
      {children}
      <ActiveCalls />
    </StreamVideo>
  );
}
