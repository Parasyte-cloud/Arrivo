import "./i18n"; // side-effect: initializes i18next before anything renders

import React from "react";
import { View, ActivityIndicator } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";

import { AuthProvider, useAuth } from "./context/AuthContext";
import { usePushNotifications } from "./hooks/usePushNotifications";

import LoginScreen from "./screens/LoginScreen";
import SignupScreen from "./screens/SignupScreen";
import CompleteProfileScreen from "./screens/CompleteProfileScreen";
import HomeScreen from "./screens/HomeScreen";
import RouteScreen from "./screens/RouteScreen";
import CheckoutScreen from "./screens/CheckoutScreen";
import TrackingScreen from "./screens/TrackingScreen";
import ChauffeurScreen from "./screens/ChauffeurScreen";
import OwnerScreen from "./screens/OwnerScreen";
import MembershipScreen from "./screens/MembershipScreen";
import ScanScreen from "./screens/ScanScreen";
import ActivityScreen from "./screens/ActivityScreen";
import WalletScreen from "./screens/WalletScreen";
import ProfileScreen from "./screens/ProfileScreen";
import VerifyIdScreen from "./screens/VerifyIdScreen";

import { colors } from "./theme/tokens";

const Stack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// Foreground behavior — show trip-update alerts even while the app is
// already open, not just when backgrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.ink, card: colors.ink, border: "rgba(255,255,255,0.08)" },
};

const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.ink },
  headerTintColor: colors.cream,
  headerTitleStyle: { color: colors.cream },
  contentStyle: { backgroundColor: colors.ink },
};

// Home tab is its own stack so booking flows (Route -> Checkout / Tracking / Chauffeur / Owner)
// can be pushed on top without losing the bottom tab bar structure.
function HomeStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="HomeMain" component={HomeScreen} options={{ title: "RideArrivo" }} />
      <Stack.Screen name="Route" component={RouteScreen} options={{ title: "Plan Route" }} />
      <Stack.Screen name="Checkout" component={CheckoutScreen} options={{ title: "Confirm & Pay" }} />
      <Stack.Screen name="Tracking" component={TrackingScreen} options={{ title: "Live Tracking" }} />
      <Stack.Screen name="Chauffeur" component={ChauffeurScreen} options={{ title: "Chauffeur Booking" }} />
      <Stack.Screen name="Owner" component={OwnerScreen} options={{ title: "Owner Dashboard" }} />
      <Stack.Screen name="Membership" component={MembershipScreen} options={{ title: "Membership" }} />
      <Stack.Screen name="Scan" component={ScanScreen} options={{ title: "Scan to Start Tracking" }} />
    </Stack.Navigator>
  );
}

const ICONS = {
  Home: "home",
  Activity: "time",
  Wallet: "wallet",
  Profile: "person",
};

// Profile tab needs its own stack (same reason as HomeStack above) so
// VerifyIdScreen can push on top of it with a real back button, instead of
// only being reachable as a modal or another tab.
function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="ProfileMain" component={ProfileScreen} options={{ headerShown: false }} />
      <Stack.Screen name="VerifyId" component={VerifyIdScreen} options={{ title: "Verified ID" }} />
    </Stack.Navigator>
  );
}

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
      <Tab.Screen name="Home" component={HomeStack} />
      <Tab.Screen name="Activity" component={ActivityScreen} />
      <Tab.Screen name="Wallet" component={WalletScreen} />
      <Tab.Screen name="Profile" component={ProfileStack} />
    </Tab.Navigator>
  );
}

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

function RootNavigator() {
  const { isAuthenticated, initializing, token, user } = useAuth();
  usePushNotifications(token);

  if (initializing) {
    // Restoring a saved session token — brief splash-like loading state.
    return (
      <View style={{ flex: 1, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.amber} size="large" />
      </View>
    );
  }

  if (!isAuthenticated) return <AuthFlow />;

  // Google/Apple sign-in only ever gives us a name + email — WhatsApp
  // number and country of residence are required fields the password
  // signup form collects inline (see SignupScreen.js), but an OAuth account
  // can reach here without them. Checking the real user record (rather
  // than a one-time "isNewAccount" flag that wouldn't survive an app
  // restart) means a password-signup rider is never affected, and anyone
  // who closes the app mid-way through this lands right back on it next
  // launch instead of slipping through with an incomplete profile.
  if (!user?.whatsapp_number || !user?.country_of_residence) {
    return <CompleteProfileScreen />;
  }

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
