// Custom entry point, replacing Expo's default node_modules/expo/AppEntry.js
// (see package.json's "main" field). Required so setPushConfig()/
// setFirebaseListeners() run and register with the native side BEFORE
// the app's React tree ever mounts — the whole point of a background
// push-triggered incoming call is that it can wake the app from a fully
// killed state, so this registration can't wait for App.js to render.
import { setPushConfig } from "./utils/setPushConfig";
import { setFirebaseListeners } from "./utils/setFirebaseListeners";

setPushConfig();
setFirebaseListeners();

import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
