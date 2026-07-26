module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // react-native-worklets' plugin (needed by react-native-reanimated v4,
    // itself needed by stream-chat-expo's message list) MUST be listed
    // last — it rewrites code the other plugins/presets above it produce,
    // so an earlier position silently breaks worklet extraction.
    plugins: ["react-native-worklets/plugin"],
  };
};
