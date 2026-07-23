import React, { useCallback, useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";

import { AuthProvider, useAuth } from "./context/AuthContext";
import { getDriverProfile } from "./services/api";
import LaunchIntro from "./components/LaunchIntro";

import LoginScreen from "./screens/LoginScreen";
import SignupScreen from "./screens/SignupScreen";
import DriverProfileScreen from "./screens/DriverProfileScreen";
import DashboardScreen from "./screens/DashboardScreen";
import EarningsScreen from "./screens/EarningsScreen";
import ProfileScreen from "./screens/ProfileScreen";

import { colors } from "./theme/tokens";

const AuthStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.ink, card: colors.ink, border: "rgba(255,255,255,0.08)" },
};

function AuthFlow() {
  return (
    // Auth screens are the one part of the app that stays light-cream
    // (matching the website's marketing pages) while everything past login
    // is dark-navy "Liquid Glass" — the navigator's default background
    // otherwise falls back to navTheme's dark ink, which would flash/bleed
    // through at screen edges and transitions on Login/Signup.
    <AuthStack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.cream } }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
    </AuthStack.Navigator>
  );
}

const ICONS = { Dashboard: "car-sport", Earnings: "cash", Profile: "person" };

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.amber,
        tabBarInactiveTintColor: "#5F5F8F",
        tabBarStyle: { backgroundColor: colors.ink, borderTopColor: "rgba(255,255,255,0.08)" },
        tabBarIcon: ({ color, size }) => <Ionicons name={ICONS[route.name]} size={size - 4} color={color} />,
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Earnings" component={EarningsScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

function Loading() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={colors.amber} size="large" />
    </View>
  );
}

function RootNavigator() {
  const { isAuthenticated, initializing, token } = useAuth();
  const [checkingProfile, setCheckingProfile] = useState(true);
  const [hasProfile, setHasProfile] = useState(false);
  // Plays once per cold launch, independent of how long the auth check
  // takes — a consistent brand moment every time, not something that only
  // shows up on a slow session restore. Falls through to the exact same
  // initializing/auth logic as before once it finishes.
  const [introDone, setIntroDone] = useState(false);

  const checkProfile = useCallback(async () => {
    if (!token) return;
    setCheckingProfile(true);
    try {
      await getDriverProfile(token);
      setHasProfile(true);
    } catch (e) {
      setHasProfile(false); // no profile yet (404) — send them to the setup screen
    } finally {
      setCheckingProfile(false);
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) checkProfile();
  }, [isAuthenticated, checkProfile]);

  if (!introDone) return <LaunchIntro onFinish={() => setIntroDone(true)} />;
  if (initializing) return <Loading />;
  if (!isAuthenticated) return <AuthFlow />;
  if (checkingProfile) return <Loading />;
  if (!hasProfile) return <DriverProfileScreen onComplete={() => setHasProfile(true)} />;

  return <MainTabs />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <RootNavigator />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
