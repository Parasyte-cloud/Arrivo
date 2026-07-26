import { StreamVideoClient, StreamVideoRN } from "@stream-io/video-react-native-sdk";
import { fetchStreamCallAuth } from "./streamPushAuth";

// Push provider names — these must EXACTLY match whatever names are used
// when registering the Firebase/APNs credentials for THIS app (driver) in
// the Stream Dashboard's Push Notifications settings. The rider app uses
// its own distinct set (see its own utils/setPushConfig.js) since it has a
// different bundle id / package name and therefore its own Firebase
// Android app + Apple VoIP certificate.
const IOS_PUSH_PROVIDER_NAME = "apn-video-driver";
const ANDROID_PUSH_PROVIDER_NAME = "firebase-video-driver";

export function setPushConfig() {
  StreamVideoRN.setPushConfig({
    ios: {
      pushProviderName: IOS_PUSH_PROVIDER_NAME,
      // Riders and drivers can now start either a voice-only or a video
      // call (see DashboardScreen.js's callRiderInApp) — CallKit needs
      // supportsVideo: true so its native incoming-call screen offers a
      // camera-enabled answer path instead of assuming audio-only.
      supportsVideo: true,
      callsHistory: true,
      displayCallTimeout: 60000,
      // Without this, an accepted call would drop the instant the driver
      // locks their phone or switches apps mid-conversation — CallKit
      // needs this to keep reporting the call as ongoing in the
      // background. Paired with "iosKeepCallAlive": true on the
      // @stream-io/video-react-native-sdk config plugin in app.json.
      enableOngoingCalls: true,
    },
    android: {
      pushProviderName: ANDROID_PUSH_PROVIDER_NAME,
      incomingChannel: {
        id: "incoming_call_channel",
        name: "Call notifications",
        vibration: true,
      },
      // Same reasoning as iOS above — keeps the call alive via a
      // foreground service when backgrounded. Paired with
      // "androidKeepCallAlive": true in app.json.
      enableOngoingCalls: true,
    },
    // A driver mid-trip only has one rider to talk to at a time — reject a
    // second incoming call outright rather than interrupting the first.
    shouldRejectCallWhenBusy: true,

    createStreamVideoClient: async () => {
      const auth = await fetchStreamCallAuth().catch((e) => {
        console.error("Could not set up calling (push):", e.message);
        return null;
      });
      if (!auth) return undefined;

      const tokenProvider = async () => {
        const fresh = await fetchStreamCallAuth();
        if (!fresh) throw new Error("Not logged in");
        return fresh.videoToken;
      };

      return StreamVideoClient.getOrCreateInstance({
        apiKey: auth.apiKey,
        user: { id: auth.userId },
        tokenProvider,
        options: { rejectCallWhenBusy: true },
      });
    },
  });
}
