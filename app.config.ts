import { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "ANBORA", slug: "anbora", scheme: "anbora", version: "0.1.0", orientation: "portrait",
  userInterfaceStyle: "automatic", newArchEnabled: true,
  android: {
    package: "com.anbora.app",
    googleServicesFile: "./google-services.json", // download from Firebase console (needed for FCM)
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY } },
    permissions: ["POST_NOTIFICATIONS"],
  },
  ios: { bundleIdentifier: "com.anbora.app", supportsTablet: false },
  plugins: [
    "expo-router",
    ["expo-location", {
      locationWhenInUsePermission: "ANBORA uses your location only when you ask it to show or share where you are.",
      locationAlwaysAndWhenInUsePermission: "ANBORA uses background location only if you turn on location sharing, so your chosen contacts can find you. You can pause or stop it any time.",
      isAndroidBackgroundLocationEnabled: true, isAndroidForegroundServiceEnabled: true, isIosBackgroundLocationEnabled: true,
    }],
    ["expo-notifications", { color: "#147D78" }],
  ],
};
export default config;
