import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Card, Button } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import ParasyteSignature from "../components/ParasyteSignature";
import PhoneInput from "../components/PhoneInput";
import WhenField from "../tiers/WhenField";
import { REQUEST_TIERS, validateRequest } from "../tiers/requestTiers";
import { colors, radius, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { createServiceRequest } from "../services/api";
import { splitPhone, validatePhone } from "../utils/phoneValidation";
import { messageWithCode } from "../utils/errorRef";

// One short form for ArrivoAir, ArrivoBoat and ArrivoRemovals. What it asks
// for comes from tiers/requestTiers.js, so the three tiers cannot drift apart.
export default function RequestFormScreen({ route, navigation }) {
  const tierId = route.params?.tierId;
  const cfg = REQUEST_TIERS[tierId];
  const { token, user } = useAuth();

  const [pickupAddress, setPickup] = useState("");
  const [destinationAddress, setDestination] = useState("");
  const [when, setWhen] = useState(null);
  const [passengerCount, setPassengers] = useState("1");
  const [option, setOption] = useState("");
  const [crewSize, setCrew] = useState(null);
  const [details, setDetails] = useState("");
  const [phone, setPhone] = useState(() => splitPhone(user?.phone || user?.whatsapp_number));
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [busy, setBusy] = useState(false);
  // One key per form. A double tap, or a retry after a dropped connection,
  // returns the same request instead of making a second one.
  const idempotencyKey = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).current;
  const submitting = useRef(false);

  const clear = useCallback((field) => setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e)), []);

  const sheetTitle = useMemo(() => (cfg ? cfg.label : "Request"), [cfg]);
  React.useLayoutEffect(() => {
    navigation.setOptions({ title: sheetTitle });
  }, [navigation, sheetTitle]);

  if (!cfg) {
    return (
      <View style={styles.screen}>
        <GradientBackground variant="dark" />
        <Text style={styles.missing}>This service is not available. Go back and choose another.</Text>
      </View>
    );
  }

  const submit = async () => {
    if (submitting.current) return;
    setSubmitError(null);

    const phoneCheck = validatePhone(phone.dial, phone.national);
    const result = validateRequest(
      tierId,
      { pickupAddress, destinationAddress, when, passengerCount, option, crewSize, details, contactPhone: phoneCheck.valid ? phoneCheck.full : "" },
      Date.now()
    );
    // The phone control has its own country-aware check, so its message wins.
    const nextErrors = { ...result.errors };
    if (!phoneCheck.valid) nextErrors.contactPhone = phoneCheck.message;
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }

    submitting.current = true;
    setBusy(true);
    try {
      const { request } = await createServiceRequest(token, { ...result.payload, idempotencyKey });
      navigation.replace("RequestStatus", { requestId: request.id, justSent: true });
    } catch (e) {
      setSubmitError(messageWithCode(e, "We could not send your request. Please try again."));
      submitting.current = false;
      setBusy(false);
    }
  };

  const showPassengers = cfg.maxPassengers > 1;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <GradientBackground variant="dark" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Field label={cfg.pickupLabel} error={errors.pickupAddress}>
            <TextInput
              style={styles.input}
              value={pickupAddress}
              onChangeText={(v) => { setPickup(v); clear("pickupAddress"); }}
              placeholder={cfg.pickupHint}
              placeholderTextColor={colors.dark.textMuted}
              maxLength={300}
              accessibilityLabel={cfg.pickupLabel}
            />
          </Field>
          <Field label={cfg.destinationLabel} error={errors.destinationAddress}>
            <TextInput
              style={styles.input}
              value={destinationAddress}
              onChangeText={(v) => { setDestination(v); clear("destinationAddress"); }}
              placeholder={cfg.destinationHint}
              placeholderTextColor={colors.dark.textMuted}
              maxLength={300}
              accessibilityLabel={cfg.destinationLabel}
            />
          </Field>
          <WhenField label={cfg.whenLabel} onChange={(d) => { setWhen(d); if (d) clear("when"); }} error={errors.when} />
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.label}>{cfg.optionLabel}</Text>
          <View style={styles.chips}>
            {cfg.options.map((o) => (
              <Chip key={o.value} label={o.label} active={option === o.value} onPress={() => { setOption(o.value); clear("option"); }} />
            ))}
          </View>
          {errors.option ? <Text style={styles.error}>{errors.option}</Text> : null}

          {cfg.usesCrewSize ? (
            <View style={{ marginTop: spacing.md }}>
              <Text style={styles.label}>{cfg.crewLabel}</Text>
              <View style={styles.chips}>
                {cfg.crewSizes.map((c) => (
                  <Chip key={c} label={`${c} movers`} active={crewSize === c} onPress={() => { setCrew(c); clear("crewSize"); }} />
                ))}
              </View>
              {errors.crewSize ? <Text style={styles.error}>{errors.crewSize}</Text> : null}
            </View>
          ) : null}

          {showPassengers ? (
            <View style={{ marginTop: spacing.md }}>
              <Text style={styles.label}>{cfg.passengerLabel}</Text>
              <Stepper
                value={passengerCount}
                min={1}
                max={cfg.maxPassengers}
                onChange={(v) => { setPassengers(v); clear("passengerCount"); }}
              />
              {errors.passengerCount ? <Text style={styles.error}>{errors.passengerCount}</Text> : null}
            </View>
          ) : null}
        </Card>

        <Card tone="dark" style={{ marginBottom: spacing.md }}>
          <Text style={styles.label}>Number we can call</Text>
          <PhoneInput
            tone="dark"
            dial={phone.dial}
            national={phone.national}
            onChangeDial={(dial) => { setPhone((p) => ({ ...p, dial })); clear("contactPhone"); }}
            onChangeNational={(national) => { setPhone((p) => ({ ...p, national })); clear("contactPhone"); }}
          />
          {errors.contactPhone ? <Text style={styles.error}>{errors.contactPhone}</Text> : null}

          <Text style={[styles.label, { marginTop: spacing.md }]}>Anything else? (optional)</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={details}
            onChangeText={(v) => { setDetails(v); clear("details"); }}
            placeholder={cfg.detailsHint}
            placeholderTextColor={colors.dark.textMuted}
            multiline
            maxLength={1000}
            accessibilityLabel="Details"
          />
          {errors.details ? <Text style={styles.error}>{errors.details}</Text> : null}
        </Card>

        {Object.keys(errors).some((k) => errors[k]) ? (
          <Text style={styles.summaryError}>Please check the highlighted fields.</Text>
        ) : null}
        {submitError ? <Text style={styles.summaryError}>{submitError}</Text> : null}

        {busy ? <ActivityIndicator color={colors.amber} /> : <Button label="Send request" onPress={submit} trailingIcon />}
        <Text style={styles.note}>No payment now. Our team will call you with the price before anything is confirmed.</Text>

        <ParasyteSignature />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, error, children }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, error && styles.inputWrapError]}>{children}</View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function Chip({ label, active, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Stepper({ value, min, max, onChange }) {
  const n = Number(value) || min;
  const set = (next) => onChange(String(Math.max(min, Math.min(max, next))));
  return (
    <View style={styles.stepper}>
      <Pressable style={styles.stepBtn} onPress={() => set(n - 1)} accessibilityRole="button" accessibilityLabel="Fewer passengers">
        <Text style={styles.stepBtnText}>-</Text>
      </Pressable>
      <Text style={styles.stepValue} accessibilityLabel={`${n} passengers`}>{n}</Text>
      <Pressable style={styles.stepBtn} onPress={() => set(n + 1)} accessibilityRole="button" accessibilityLabel="More passengers">
        <Text style={styles.stepBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  content: { padding: spacing.lg, paddingBottom: 40 },
  missing: { color: colors.dark.text, padding: spacing.xl, textAlign: "center" },
  label: { color: colors.dark.textMuted, fontSize: 12, fontWeight: "600", marginBottom: 6 },
  inputWrap: { backgroundColor: colors.dark.fieldBg, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: "transparent" },
  inputWrapError: { borderColor: "#FF9B8A" },
  input: { color: colors.dark.text, fontSize: 16, paddingHorizontal: spacing.md, paddingVertical: 12, minHeight: 48 },
  multiline: { backgroundColor: colors.dark.fieldBg, borderRadius: radius.sm + 2, minHeight: 90, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.dark.surfaceBorder, backgroundColor: colors.dark.fieldBg },
  chipActive: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { color: colors.dark.text, fontSize: 13.5, fontWeight: "600" },
  chipTextActive: { color: colors.ink, fontWeight: "800" },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  stepBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.dark.surfaceBorder, backgroundColor: colors.dark.fieldBg, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: colors.dark.text, fontSize: 22, fontWeight: "700", lineHeight: 26 },
  stepValue: { color: colors.dark.text, fontSize: 20, fontWeight: "800", minWidth: 36, textAlign: "center" },
  error: { color: "#FF9B8A", fontSize: 12, marginTop: 6 },
  summaryError: { color: "#FF9B8A", fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
  note: { color: colors.dark.textMuted, fontSize: 12, textAlign: "center", marginTop: spacing.md, lineHeight: 17 },
});
