import React, { useCallback, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl, TextInput, Modal, FlatList, Pressable, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Card, Button, Tag } from "../components/UI";
import { GradientBackground } from "../components/GradientBackground";
import { colors, spacing } from "../theme/tokens";
import { useAuth } from "../context/AuthContext";
import { useT } from "../context/LanguageContext";
import { TRANSLATIONS } from "../i18n/translations";
import { formatNumber } from "../i18n/i18n";
import { getCashout, getCashoutBanks, saveCashoutBank, withdrawCashout } from "../services/api";
import { parseAmount, statusTone, errorKey, newIdempotencyKey, filterBanks } from "../utils/cashout";

// Turn a wallet balance into money in the driver's own bank account.
// Text comes from i18n/translations.js.

export default function CashoutScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { t, lang } = useT();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [editingBank, setEditingBank] = useState(false);
  const [banks, setBanks] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bankQuery, setBankQuery] = useState("");
  const [bank, setBank] = useState(null);
  const [accountNumber, setAccountNumber] = useState("");
  const [amountText, setAmountText] = useState("");
  const attemptKey = useRef(newIdempotencyKey());

  const errText = useCallback((e) => {
    const key = errorKey(e, (k) => Boolean(TRANSLATIONS.en[k]));
    if (key) return t(key, e.params);
    return e && e.status && e.status < 500 && e.message ? e.message : t("e_generic");
  }, [t]);

  const load = useCallback(async () => {
    try {
      setData(await getCashout(token));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [token, errText]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openBankEditor = async () => {
    setEditingBank(true); setError(null); setNotice(null);
    if (!banks.length) {
      try { setBanks((await getCashoutBanks(token)).banks); } catch (e) { setError(errText(e)); }
    }
  };

  const saveBank = async () => {
    if (!bank) { setError(t("e_UNKNOWN_BANK")); return; }
    setBusy(true); setError(null);
    try {
      await saveCashoutBank(token, bank.code, accountNumber.trim());
      setEditingBank(false); setAccountNumber(""); setBank(null);
      setNotice(t("bankNote"));
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = () => {
    const amount = parseAmount(amountText);
    if (!amount) { setError(t("e_INVALID_AMOUNT")); return; }
    setError(null); setNotice(null);
    Alert.alert(
      t("confirmTitle"),
      t("confirmBody", { amount: formatNumber(amount), bank: data.bank.bankName, account: data.bank.accountMasked }),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("confirm"),
          onPress: async () => {
            setBusy(true);
            try {
              await withdrawCashout(token, amount, attemptKey.current);
              attemptKey.current = newIdempotencyKey(); // the next cash-out is a new request
              setAmountText("");
              setNotice(t("requestSent"));
              await load();
            } catch (e) {
              setError(errText(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const canWithdraw = data && data.enabled && data.bank && parseAmount(amountText) && !busy;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <GradientBackground variant="dark" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.amber} />}
      >
        {loading && !data ? <ActivityIndicator color={colors.amber} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        {data ? (
          <>
            <Card tone="dark" tinted style={{ marginBottom: spacing.md }}>
              <Text style={styles.label}>{t("walletBalance")}</Text>
              <Text style={styles.big}>₦{formatNumber(data.balanceNaira)}</Text>
              <Text style={[styles.label, { marginTop: spacing.sm }]}>{t("canCashOut")}</Text>
              <Text style={[styles.big, { color: colors.amber }]}>₦{formatNumber(data.withdrawableNaira)}</Text>
              <Text style={styles.small}>{t("onlyEarnings")}</Text>
            </Card>

            {!data.enabled ? <Text style={styles.notice}>{t("closedNote")}</Text> : null}

            <Card tone="dark" style={{ marginBottom: spacing.md }}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{t("bankTitle")}</Text>
                {data.bank && !editingBank ? <Text style={styles.link} onPress={openBankEditor}>{t("changeBank")}</Text> : null}
              </View>

              {data.bank && !editingBank ? (
                <>
                  <Text style={styles.value}>{data.bank.bankName} {data.bank.accountMasked}</Text>
                  <Text style={styles.small}>{data.bank.accountName}</Text>
                </>
              ) : editingBank ? (
                <>
                  <Pressable style={styles.input} onPress={() => setPickerOpen(true)} accessibilityRole="button">
                    <Text style={{ color: bank ? colors.dark.text : colors.dark.textMuted }}>{bank ? bank.name : t("chooseBank")}</Text>
                  </Pressable>
                  <TextInput
                    style={styles.input} value={accountNumber} onChangeText={(v) => setAccountNumber(v.replace(/\D/g, "").slice(0, 10))}
                    placeholder={t("accountNumber")} placeholderTextColor={colors.dark.textMuted} keyboardType="number-pad" maxLength={10}
                  />
                  <Button label={busy ? "…" : t("saveBank")} onPress={saveBank} tone="dark" disabled={busy || accountNumber.length !== 10 || !bank} />
                  <Text style={[styles.small, { marginTop: spacing.sm }]}>{t("bankNote")}</Text>
                </>
              ) : (
                <>
                  <Text style={styles.small}>{t("bankNote")}</Text>
                  <View style={{ height: spacing.sm }} />
                  <Button label={t("addBank")} onPress={openBankEditor} tone="dark" />
                </>
              )}
            </Card>

            {data.bank && !editingBank ? (
              <Card tone="dark" style={{ marginBottom: spacing.md }}>
                <Text style={styles.cardTitle}>{t("cashoutTitle")}</Text>
                <TextInput
                  style={styles.input} value={amountText} onChangeText={setAmountText} placeholder={t("amountLabel")}
                  placeholderTextColor={colors.dark.textMuted} keyboardType="number-pad"
                />
                <Text style={styles.small}>
                  {t("limitsLine", { min: formatNumber(data.limits.minNaira), max: formatNumber(data.limits.maxNaira), daily: formatNumber(data.limits.dailyMaxNaira) })}
                </Text>
                <View style={{ height: spacing.sm }} />
                <Button label={busy ? "…" : t("withdrawBtn")} onPress={withdraw} tone="dark" disabled={!canWithdraw} />
              </Card>
            ) : null}

            <Text style={styles.sectionLabel}>{t("historyTitle")}</Text>
            {data.history.length === 0 ? <Text style={styles.empty}>{t("noHistory")}</Text> : null}
            {data.history.map((w) => (
              <Card key={w.id} tone="dark" style={{ marginBottom: spacing.sm }}>
                <View style={styles.rowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.value}>₦{formatNumber(w.amountNaira)}</Text>
                    <Text style={styles.small}>{w.bankName} ****{w.accountLast4} · {new Date(w.requestedAt).toLocaleDateString()}</Text>
                  </View>
                  <Tag label={t(`st_${w.status}`)} tone={statusTone(w.status)} />
                </View>
              </Card>
            ))}
          </>
        ) : null}
      </ScrollView>

      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={[styles.screen, { paddingTop: insets.top + spacing.md, paddingHorizontal: spacing.lg }]}>
          <TextInput
            style={styles.input} value={bankQuery} onChangeText={setBankQuery} placeholder={t("searchBank")}
            placeholderTextColor={colors.dark.textMuted} autoFocus
          />
          <FlatList
            data={filterBanks(banks, bankQuery)} keyExtractor={(b) => b.code} keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable style={styles.bankRow} onPress={() => { setBank(item); setPickerOpen(false); setBankQuery(""); }}>
                <Text style={styles.value}>{item.name}</Text>
              </Pressable>
            )}
          />
          <Button label={t("cancel")} onPress={() => setPickerOpen(false)} tone="dark" variant="ghost" style={{ marginBottom: insets.bottom + spacing.md }} />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.dark.bg0 },
  label: { color: colors.dark.textMuted, fontSize: 11 },
  big: { color: colors.dark.text, fontSize: 24, fontWeight: "800", marginTop: 2 },
  small: { color: colors.dark.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
  cardTitle: { color: colors.dark.text, fontSize: 14, fontWeight: "700", marginBottom: spacing.sm },
  value: { color: colors.dark.text, fontSize: 14, fontWeight: "600" },
  link: { color: colors.tealBright, fontSize: 12.5, fontWeight: "600" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  input: {
    backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 14, paddingVertical: 13, color: colors.dark.text, fontSize: 14, marginBottom: spacing.sm,
  },
  bankRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" },
  sectionLabel: { color: colors.dark.textMuted, fontSize: 12, fontWeight: "600", marginBottom: spacing.sm, textTransform: "uppercase", letterSpacing: 0.5 },
  error: { color: "#FF9B8A", fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
  notice: { color: colors.amber, fontSize: 12.5, marginBottom: spacing.md, textAlign: "center" },
  empty: { color: colors.dark.textMuted, fontSize: 13, textAlign: "center", marginTop: spacing.sm },
});
