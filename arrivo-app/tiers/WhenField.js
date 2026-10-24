import React, { useEffect, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../theme/tokens";
import { combineLagos, earliestInstant, formatLagos, wallClockDate } from "../utils/lagosTime";

function dateText(d) {
  return d ? d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : "Choose date";
}
function timeText(d) {
  return d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Choose time";
}

// Date and time as two plain taps, shown in Lagos time whatever the phone's
// zone. Reports one real moment (a Date) once both are chosen, otherwise null.
// Android opens its own dialog and closes it on selection. iOS needs a sheet
// with a Done button, same pattern as the Chauffer screen.
export default function WhenField({ label, onChange, error }) {
  const [dateValue, setDateValue] = useState(null);
  const [timeValue, setTimeValue] = useState(null);
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const start = wallClockDate(earliestInstant(1));

  useEffect(() => {
    onChange(combineLagos(dateValue, timeValue));
    // onChange is the parent's setter and is stable enough; only the picks matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateValue, timeValue]);

  const instant = combineLagos(dateValue, timeValue);

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable style={[styles.pick, error && styles.pickError]} onPress={() => setShowDate(true)} accessibilityRole="button" accessibilityLabel={`${label} date`}>
          <Ionicons name="calendar-outline" size={16} color={colors.dark.textMuted} />
          <Text style={[styles.pickText, !dateValue && styles.placeholder]}>{dateText(dateValue)}</Text>
        </Pressable>
        <Pressable style={[styles.pick, error && styles.pickError]} onPress={() => setShowTime(true)} accessibilityRole="button" accessibilityLabel={`${label} time`}>
          <Ionicons name="time-outline" size={16} color={colors.dark.textMuted} />
          <Text style={[styles.pickText, !timeValue && styles.placeholder]}>{timeText(timeValue)}</Text>
        </Pressable>
      </View>
      {instant ? <Text style={styles.hint}>{formatLagos(instant)}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {showDate && Platform.OS === "android" ? (
        <DateTimePicker
          value={dateValue || start}
          mode="date"
          display="default"
          minimumDate={start}
          onChange={(event, selected) => {
            setShowDate(false);
            if (event.type === "dismissed") return;
            if (selected) setDateValue(selected);
          }}
        />
      ) : null}
      {showTime && Platform.OS === "android" ? (
        <DateTimePicker
          value={timeValue || start}
          mode="time"
          display="default"
          onChange={(event, selected) => {
            setShowTime(false);
            if (event.type === "dismissed") return;
            if (selected) setTimeValue(selected);
          }}
        />
      ) : null}

      <Modal visible={Platform.OS === "ios" && showDate} animationType="slide" transparent onRequestClose={() => setShowDate(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowDate(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{label} date</Text>
              <Pressable onPress={() => setShowDate(false)} hitSlop={10}>
                <Text style={styles.done}>Done</Text>
              </Pressable>
            </View>
            <DateTimePicker
              value={dateValue || start}
              mode="date"
              display="inline"
              minimumDate={start}
              onChange={(event, selected) => {
                if (selected) setDateValue(selected);
              }}
            />
          </View>
        </Pressable>
      </Modal>

      <Modal visible={Platform.OS === "ios" && showTime} animationType="slide" transparent onRequestClose={() => setShowTime(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowTime(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{label} time</Text>
              <Pressable onPress={() => setShowTime(false)} hitSlop={10}>
                <Text style={styles.done}>Done</Text>
              </Pressable>
            </View>
            <DateTimePicker
              value={timeValue || start}
              mode="time"
              display="spinner"
              onChange={(event, selected) => {
                if (selected) setTimeValue(selected);
              }}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.dark.textMuted, fontSize: 12, fontWeight: "600", marginBottom: 6 },
  row: { flexDirection: "row", gap: spacing.sm },
  pick: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm + 2,
    backgroundColor: colors.dark.fieldBg,
    borderWidth: 1,
    borderColor: "transparent",
  },
  pickError: { borderColor: "#FF9B8A" },
  pickText: { color: colors.dark.text, fontSize: 14, fontWeight: "600" },
  placeholder: { color: colors.dark.textMuted, fontWeight: "400" },
  hint: { color: colors.amber, fontSize: 12, fontWeight: "600", marginTop: 6 },
  error: { color: "#FF9B8A", fontSize: 12, marginTop: 6 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.dark.bg1, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20 },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.md },
  sheetTitle: { color: colors.dark.text, fontWeight: "700", fontSize: 15 },
  done: { color: colors.amber, fontWeight: "700", fontSize: 14 },
});
