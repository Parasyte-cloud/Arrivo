// iOS (and any other non-Android platform) uses APNs VoIP push directly
// for incoming calls (see utils/setPushConfig.js) — Firebase is only
// present on iOS at all for @stream-io/video-react-native-sdk's build-time
// native linking requirements (see the expo-build-properties config in
// app.json), never for actual push delivery there. Real Android
// implementation lives in utils/setFirebaseListeners.android.js — Metro's
// platform-extension resolution picks that file over this one
// automatically on Android.
export const setFirebaseListeners = () => {
  // do nothing
};
