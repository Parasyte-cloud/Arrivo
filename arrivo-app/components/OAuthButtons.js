import React, { useEffect } from "react";
import { View, Text, Pressable, StyleSheet, Platform, ActivityIndicator } from "react-native";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import * as AppleAuthentication from "expo-apple-authentication";
import { useTranslation } from "react-i18next";
import { colors, spacing, tint } from "../theme/tokens";
import { reportClientError } from "../services/api";

// Needed once, at module load, so the in-app browser sheet Google sign-in
// opens actually closes itself and hands control back to the app when the
// redirect comes in — without this the browser can be left open after a
// successful sign-in.
WebBrowser.maybeCompleteAuthSession();

// Client IDs come from app.json's extra.googleOAuth (see app.json + the
// setup notes in the README this ships with) — created in Google Cloud
// Console, one OAuth client per platform. Never hardcoded here since these
// differ between the rider and driver app's own Google Cloud projects.
const GOOGLE_IOS_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.iosClientId;
const GOOGLE_ANDROID_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.androidClientId;
const GOOGLE_WEB_CLIENT_ID = Constants.expoConfig?.extra?.googleOAuth?.webClientId;

// On iOS, Google's authorization server only accepts a redirect back to the
// app via a very specific "reversed client ID" URL scheme — it does NOT
// accept the app's own generic scheme (app.json's top-level "scheme"), which
// is what expo-auth-session falls back to if no redirectUri is given. That
// mismatch is exactly what threw "Error 400: redirect_uri_mismatch" on
// Google's own sign-in page. This scheme must also be registered as a
// CFBundleURLType in app.json's ios.infoPlist — both halves are required.
const GOOGLE_IOS_URL_SCHEME = GOOGLE_IOS_CLIENT_ID
  ? `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace(".apps.googleusercontent.com", "")}`
  : undefined;

// Google and Apple sign-in are off on iOS for now while we sort out App Review.
// Apple won't take Google without Apple next to it, so both go. Android keeps Google.
export const SHOW_SOCIAL_SIGN_IN = Platform.OS !== "ios";

// Renders "Continue with Google" (both platforms) and "Sign in with Apple"
// (iOS only, per Apple's own button — Android has no Apple button at all).
// `disabled` is how the signup screen gates these behind the data-protection
// checkbox, exactly like the "Create account" button below it is gated by
// the same flag — nobody creates a RideArrivo profile any way, including via
// Google/Apple, without agreeing to the same terms.
// A sign-in that fails on the phone never reaches our server, so nothing would
// ever show up in the logs. Report it (the code Apple/Google gave, the screen,
// the build) and show the person a short Ref they can read out to support.
async function explain(stage, err, fallback) {
  const code = err && err.code ? String(err.code) : "";
  let ref = "";
  try {
    ref = await reportClientError({
      code: "OAUTH_" + stage,
      message: (err && err.message) || fallback,
      detail: code,
      screen: "oauth",
      context: { os: Platform.OS, nativeCode: code || "none" },
    });
  } catch (e) { /* reporting is best effort */ }
  return `${fallback}${code || ref ? ` (${[code, ref && "Ref " + ref].filter(Boolean).join(", ")})` : ""}`;
}

export default function OAuthButtons({ onGoogleIdToken, onGoogleError, onAppleResult, onBlocked, disabled, busy }) {
  const { t } = useTranslation();
  const googleConfigured = !!(GOOGLE_IOS_CLIENT_ID || GOOGLE_ANDROID_CLIENT_ID || GOOGLE_WEB_CLIENT_ID);

  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    // openid+email+profile is enough for account creation — RideArrivo
    // never needs any broader Google scope (contacts, calendar, etc.).
    scopes: ["openid", "profile", "email"],
    // See GOOGLE_IOS_URL_SCHEME above — without this, iOS silently falls
    // back to a redirect URI Google's server rejects. Android's OAuth client
    // type validates via package name + signing certificate instead of a
    // redirect URI, so it doesn't need (or use) this.
    ...(Platform.OS === "ios" && GOOGLE_IOS_URL_SCHEME
      ? { redirectUri: `${GOOGLE_IOS_URL_SCHEME}:/oauthredirect` }
      : {}),
  });

  useEffect(() => {
    if (!response) return;
    // Previously only handled "success" and silently dropped everything
    // else — a real Google sign-in failure (bad client config, network
    // error) left the person with zero feedback: no error text, spinner
    // just stops, nothing happens. "dismiss"/"cancel" (they backed out of
    // the picker themselves) is intentionally still silent here, matching
    // how the Apple handler below ignores ERR_REQUEST_CANCELED — only a
    // genuine "error" type is worth surfacing.
    if (response.type === "error") {
      explain("GOOGLE_RESPONSE", response.error || { code: response.params?.error }, response.error?.message || t("auth.googleFailed")).then((m) => onGoogleError && onGoogleError(m));
      return;
    }
    if (response.type !== "success") return;
    // Different Expo/expo-auth-session versions have surfaced the Google ID
    // token in slightly different places over time — checking both keeps
    // this working regardless of exactly which one this project resolved to.
    const idToken = response.authentication?.idToken || response.params?.id_token;
    if (idToken) {
      onGoogleIdToken(idToken);
    } else {
      explain("GOOGLE_NO_TOKEN", { code: "no_id_token" }, t("auth.googleIncomplete")).then((m) => onGoogleError && onGoogleError(m));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  // Never a dead button. A button that ignores taps reads as "broken" to a
  // reviewer and to a driver alike, so a blocked tap says why instead.
  const handleGoogle = () => {
    if (disabled) { onBlocked && onBlocked(); return; }
    if (!googleConfigured) { onGoogleError && onGoogleError(t("auth.googleNotReady")); return; }
    if (!request) { onGoogleError && onGoogleError(t("auth.googleNotReady")); return; }
    promptAsync().catch((e) => {
      explain("GOOGLE_PROMPT", e, t("auth.googleFailed")).then((m) => onGoogleError && onGoogleError(m));
    });
  };

  const handleAppleSignIn = async () => {
    if (disabled) { onBlocked && onBlocked(); return; }
    try {
      if (!(await AppleAuthentication.isAvailableAsync())) {
        onAppleResult({ error: await explain("APPLE_UNAVAILABLE", { code: "unavailable" }, t("auth.appleUnavailable")) });
        return;
      }
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      // fullName is only ever populated on the very first authorization —
      // the caller has to send it to the backend right now, since Apple
      // never hands it over again on later sign-ins.
      // authorizationCode is one-time and only useful right now: the backend
      // swaps it for a refresh token, which is the only thing that can revoke
      // this Apple authorization when the account is deleted.
      if (!credential.identityToken) {
        onAppleResult({ error: await explain("APPLE_NO_TOKEN", { code: "no_identity_token" }, t("auth.appleFailed")) });
        return;
      }
      onAppleResult({
        identityToken: credential.identityToken,
        fullName: credential.fullName,
        authorizationCode: credential.authorizationCode,
      });
    } catch (e) {
      if (e.code === "ERR_REQUEST_CANCELED") return; // person just backed out — not an error
      onAppleResult({ error: await explain("APPLE_SIGNIN", e, t("auth.appleFailed")) });
    }
  };

  return (
    <View style={{ gap: 10 }}>
      {busy ? (
        <View style={{ alignItems: "center", paddingVertical: spacing.sm }}>
          <ActivityIndicator color={colors.tealBright} />
        </View>
      ) : (
        <>
          {/* Always shown: a hidden button looks like a missing feature. If the keys are not in this build, a tap says so. */}
          {(
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("auth.continueWithGoogle")}
              onPress={handleGoogle}
              style={[styles.button, styles.googleButton, disabled && styles.buttonDisabled]}
            >
              <Text style={styles.googleG}>G</Text>
              <Text style={styles.buttonText}>{t("auth.continueWithGoogle")}</Text>
            </Pressable>
          )}

          {Platform.OS === "ios" ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={12}
              style={[styles.appleButton, disabled && styles.buttonDisabled]}
              onPress={handleAppleSignIn}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 13,
    borderRadius: 12,
  },
  buttonDisabled: { opacity: 0.45 },
  googleButton: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: tint(0.15),
  },
  googleG: { fontSize: 16, fontWeight: "700", color: "#4285F4" },
  buttonText: { fontSize: 14, fontWeight: "600", color: "#12123B" },
  appleButton: { width: "100%", height: 46 },
});
