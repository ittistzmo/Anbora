import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BG_TASK, ACTIVE_KEY } from "./locationTask";

export type Fix = { lat: number; lng: number; accuracy: number | null; capturedAt: number; stale: boolean };
export type FixFailure = "denied" | "services_off" | "timeout" | "error";
export type FixResult = { ok: true; fix: Fix } | { ok: false; reason: FixFailure };

const toFix = (l: Location.LocationObject, stale = false): Fix => ({ lat: l.coords.latitude, lng: l.coords.longitude, accuracy: l.coords.accuracy, capturedAt: l.timestamp, stale });
export const mapsLink = (f: Pick<Fix, "lat" | "lng">) => `https://www.google.com/maps?q=${f.lat},${f.lng}`;

export async function permissionState() {
  const fg = await Location.getForegroundPermissionsAsync();
  const bg = fg.granted ? await Location.getBackgroundPermissionsAsync() : null;
  return { foreground: fg.status, canAskAgain: fg.canAskAgain, background: bg?.status ?? "undetermined", servicesOn: await Location.hasServicesEnabledAsync() };
}
/** Call only after showing the in-app explanation screen. */
export async function requestForeground() { return (await Location.requestForegroundPermissionsAsync()).granted; }

/** Returns a real fix or a named failure. A cached fix is flagged `stale`; coordinates are never invented. */
export async function getFix(): Promise<FixResult> {
  if (!(await Location.getForegroundPermissionsAsync()).granted) return { ok: false, reason: "denied" };
  if (!(await Location.hasServicesEnabledAsync())) return { ok: false, reason: "services_off" };
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), 15000); });
    const l = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), timeout]);
    return { ok: true, fix: toFix(l) };
  } catch (e) {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null);
    if (last) return { ok: true, fix: toFix(last, true) };
    return { ok: false, reason: String(e).includes("timeout") ? "timeout" : "error" };
  } finally { if (t) clearTimeout(t); }
}

export async function addressOf(f: Fix): Promise<string | null> {
  try {
    const [a] = await Location.reverseGeocodeAsync({ latitude: f.lat, longitude: f.lng });
    return a ? [a.name, a.street, a.district, a.city, a.region].filter(Boolean).join(", ") : null;
  } catch { return null; } // network failure: UI shows coordinates only
}

/** Opt-in only. Foreground permission first; background only when the user turns sharing on. */
export async function startBackground(shareId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await Location.getForegroundPermissionsAsync()).granted) return { ok: false, reason: "foreground_required" };
  if (!(await Location.requestBackgroundPermissionsAsync()).granted) return { ok: false, reason: "background_denied" };
  await AsyncStorage.setItem(ACTIVE_KEY, shareId);
  await Location.startLocationUpdatesAsync(BG_TASK, {
    accuracy: Location.Accuracy.Balanced, timeInterval: 5 * 60_000, distanceInterval: 100, pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: { notificationTitle: "ANBORA is sharing your location", notificationBody: "Open ANBORA to pause or stop", notificationColor: "#147D78" },
  });
  return { ok: true };
}
export async function pauseBackground() { if (await Location.hasStartedLocationUpdatesAsync(BG_TASK)) await Location.stopLocationUpdatesAsync(BG_TASK); }
export async function stopBackground() { await pauseBackground(); await AsyncStorage.removeItem(ACTIVE_KEY); }
