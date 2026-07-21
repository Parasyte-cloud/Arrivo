import React, { useEffect, useRef, useState } from "react";
import { View, TextInput, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { colors, radius, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { getPlacesAutocomplete, getPlaceDetails } from "../services/api";

const DEBOUNCE_MS = 350;
const MIN_CHARS = 3;

function newSessionToken() {
  // Doesn't need to be cryptographically random — just distinct enough
  // per address-entry session for Google's billing to group an
  // autocomplete session with its eventual details lookup.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// A pickup/destination field backed by real Google Places Autocomplete
// (proxied through our backend — see services/api.js). Falls back to a
// plain free-text field with no suggestions if the rider keeps typing
// without picking a suggestion, so this never actually blocks booking —
// worst case it behaves like the old plain TextInput did.
export default function AddressAutocomplete({ value, onChangeText, onSelect, placeholder, style, inputStyle }) {
  const { token } = useAuth();
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState(null);
  const sessionTokenRef = useRef(newSessionToken());
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!focused || value.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const { predictions } = await getPlacesAutocomplete(token, value.trim(), sessionTokenRef.current);
        setSuggestions(predictions || []);
        setError(null);
      } catch (e) {
        // Non-critical — the rider can still just type a plain address and
        // book normally, same as before this feature existed.
        setSuggestions([]);
        setError("Couldn't load suggestions right now.");
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const selectSuggestion = async (prediction) => {
    setSuggestions([]);
    onChangeText(prediction.description);
    try {
      const details = await getPlaceDetails(token, prediction.placeId, sessionTokenRef.current);
      onSelect({ address: details.address || prediction.description, lat: details.lat, lng: details.lng, placeId: prediction.placeId });
    } catch (e) {
      // The address text is still filled in even if we couldn't resolve
      // coordinates — the rider isn't stuck, but the fare quote won't be
      // able to calculate until they pick a suggestion that does resolve.
      setError("Couldn't confirm that address's location. Please try selecting it again.");
    }
    sessionTokenRef.current = newSessionToken(); // fresh session for next time
  };

  return (
    <View style={style}>
      <TextInput
        style={inputStyle}
        value={value}
        onChangeText={(v) => {
          onChangeText(v);
          onSelect(null); // typing after a selection invalidates the resolved coordinates
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)} // delay so a suggestion tap registers first
        placeholder={placeholder}
        placeholderTextColor={colors.dark.textMuted}
      />
      {focused && loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.amber} />
        </View>
      ) : null}
      {focused && suggestions.length > 0 ? (
        <View style={styles.dropdown}>
          {suggestions.map((s) => (
            <Pressable key={s.placeId} onPress={() => selectSuggestion(s)} style={styles.suggestionRow}>
              <Text style={styles.suggestionText} numberOfLines={2}>{s.description}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {focused && error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingRow: { paddingVertical: 4, paddingLeft: 4 },
  dropdown: {
    backgroundColor: colors.dark.bg1,
    borderRadius: radius.sm,
    marginTop: 4,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.dark.hairline,
  },
  suggestionRow: {
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.dark.hairline,
  },
  suggestionText: { color: colors.dark.text, fontSize: 12.5 },
  errorText: { color: "#FF9B8A", fontSize: 10.5, marginTop: 2 },
});
