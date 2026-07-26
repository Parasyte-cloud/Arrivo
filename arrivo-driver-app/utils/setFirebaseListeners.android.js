import messaging from "@react-native-firebase/messaging";
import { isFirebaseStreamVideoMessage, firebaseDataHandler } from "@stream-io/video-react-native-sdk";

// Android-only real implementation — Metro picks this file automatically
// on Android over the plain setFirebaseListeners.js fallback (see that
// file's comment for why iOS doesn't need a real one here).
export const setFirebaseListeners = () => {
  messaging().setBackgroundMessageHandler(async (msg) => {
    if (isFirebaseStreamVideoMessage(msg)) {
      await firebaseDataHandler(msg.data);
    }
    // Nothing else uses raw FCM in this app today — ride/request updates
    // are handled by polling, not push, so there's nothing else to route
    // here yet.
  });

  // Foreground messages: intentionally NOT subscribed with onMessage here.
  // When the app is already in the foreground, the SDK's own in-app
  // ringing UI (see App.js's CallUI) takes over directly.
};
