import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp, DocumentReference } from "firebase-admin/firestore";
import { sendWhatsApp, sendSms, SECRETS, WA_LOCATION_TEMPLATE, SMS_LOCATION_TEMPLATE_ID } from "./providers";

if (!getApps().length) initializeApp();
const db = getFirestore();
const REGION = "asia-south1", MIN = 60_000, OPEN = ["queued", "retrying", "sending"], MAX_ATTEMPTS = 3;

const uidOf = (req: any): string => { const u = req.auth?.uid; if (!u) throw new HttpsError("unauthenticated", "Sign in first"); return u; };
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
const logLoc = (uid: string, action: string, data: object = {}) =>
  db.collection(`users/${uid}/locationLog`).add({ action, ...data, at: FieldValue.serverTimestamp() });

function parseFix(d: any) {
  const lat = num(d?.lat), lng = num(d?.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, accuracy: num(d.accuracy), clientCapturedAt: num(d.capturedAt), stale: d.stale === true };
}

/** Template variables (WhatsApp body + SMS var1..var4): 1 user name, 2 kind, 3 location text/link, 4 time. */
async function createShare(uid: string, o: { id?: string; contactIds: string[] | null; fix: ReturnType<typeof parseFix>; sos: boolean; durationMin: number }) {
  const user = (await db.doc(`users/${uid}`).get()).data();
  if (!user) throw new HttpsError("failed-precondition", "User not initialised");
  const cs = await db.collection(`users/${uid}/contacts`).where("consentStatus", "==", "granted").get();
  const chosen = cs.docs.filter((c) => !o.contactIds || o.contactIds.includes(c.id));
  if (!chosen.length) throw new HttpsError("failed-precondition", "No verified emergency contacts selected");
  const now = Timestamp.now();
  const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: user.timezone || "Asia/Kolkata" }).format(now.toDate());
  const f = o.fix;
  const where = f ? `${mapsLink(f.lat, f.lng)} (accuracy ~${f.accuracy ? Math.round(f.accuracy) : "unknown"} m${f.stale ? ", last known, may be outdated" : ""})` : "Location unavailable";
  const ref = db.collection(`users/${uid}/shares`).doc(o.id ?? db.collection("_").doc().id);
  const batch = db.batch();
  batch.create(ref, { sos: o.sos, status: "active", contactIds: chosen.map((c) => c.id), startedAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + Math.min(o.durationMin, 1440) * MIN), last: f ? { ...f, serverAt: now } : null, locationAvailable: !!f });
  let n = 0;
  for (const c of chosen) for (const ch of ["whatsapp", "sms"] as const) {
    if (c.data()[ch] === false) continue;
    batch.create(ref.collection("deliveries").doc(`${c.id}_${ch}`), { uid, shareId: ref.id, contactId: c.id, contactName: c.data().name, channel: ch,
      phone: c.data().phone, vars: [user.name, o.sos ? "an SOS alert" : "their location", where, when], status: "queued", attempts: 0, nextAttemptAt: now });
    n++;
  }
  await batch.commit();
  await logLoc(uid, o.sos ? "sos_shared" : "shared", { shareId: ref.id, recipients: chosen.length, located: !!f });
  return { shareId: ref.id, recipients: chosen.length, deliveries: n };
}

export const shareLocation = onCall({ region: REGION }, async (req) => {
  const uid = uidOf(req); const fix = parseFix(req.data?.fix);
  if (!fix) throw new HttpsError("invalid-argument", "A valid location is required");
  const ids = Array.isArray(req.data?.contactIds) ? req.data.contactIds.filter((x: unknown) => typeof x === "string") : null;
  return createShare(uid, { contactIds: ids, fix, sos: false, durationMin: Number(req.data?.durationMin) || 60 });
});

export const triggerSos = onCall({ region: REGION }, async (req) => {
  const uid = uidOf(req); const fix = parseFix(req.data?.fix);
  try { // one SOS per 2-minute bucket: double taps cannot send twice
    const r = await createShare(uid, { id: `sos_${Math.floor(Date.now() / (2 * MIN))}`, contactIds: null, fix, sos: true, durationMin: 120 });
    return { ...r, locationAvailable: !!fix };
  } catch (e: any) { if (e.code === 6) return { duplicate: true }; throw e; }
});

export const updateSharedLocation = onCall({ region: REGION }, async (req) => {
  const uid = uidOf(req); const fix = parseFix(req.data?.fix);
  const ref = db.doc(`users/${uid}/shares/${String(req.data?.shareId)}`);
  const s = (await ref.get()).data();
  if (!fix || !s || s.status !== "active" || s.expiresAt.toMillis() < Date.now()) return { accepted: false };
  if (s.last?.serverAt && Date.now() - s.last.serverAt.toMillis() < 30_000) return { accepted: false };
  await ref.update({ last: { ...fix, serverAt: Timestamp.now() }, locationAvailable: true });
  await logLoc(uid, "background_update", { shareId: ref.id });
  return { accepted: true };
});

export const setSharePaused = onCall({ region: REGION }, async (req) => {
  const uid = uidOf(req); const ref = db.doc(`users/${uid}/shares/${String(req.data?.shareId)}`);
  const s = (await ref.get()).data(); if (!s || s.status === "stopped") throw new HttpsError("not-found", "No active session");
  const paused = req.data?.paused === true;
  await ref.update({ status: paused ? "paused" : "active" });
  await logLoc(uid, paused ? "paused" : "resumed", { shareId: ref.id });
  return { status: paused ? "paused" : "active" };
});

export const stopSharing = onCall({ region: REGION }, async (req) => {
  const uid = uidOf(req); const ref = db.doc(`users/${uid}/shares/${String(req.data?.shareId)}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "No such session");
  const open = await ref.collection("deliveries").where("status", "in", OPEN).get();
  const b = db.batch(); open.docs.forEach((d) => b.update(d.ref, { status: "cancelled" }));
  b.update(ref, { status: "stopped", stoppedAt: Timestamp.now() }); await b.commit();
  await logLoc(uid, "stopped", { shareId: ref.id });
  return { stopped: true, cancelledDeliveries: open.size };
});

async function deliver(ref: DocumentReference) {
  const a = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || !OPEN.includes(d.status) || d.nextAttemptAt.toMillis() > Date.now()) return null;
    tx.update(ref, { status: "sending", nextAttemptAt: Timestamp.fromMillis(Date.now() + 10 * MIN) });
    return d;
  });
  if (!a) return;
  try {
    const id = a.channel === "whatsapp" ? await sendWhatsApp(a.phone, a.vars, WA_LOCATION_TEMPLATE.value())
      : await sendSms(a.phone, a.vars, SMS_LOCATION_TEMPLATE_ID.value());
    await ref.update({ status: "sent_to_provider", providerMessageId: id, attempts: a.attempts + 1, sentAt: FieldValue.serverTimestamp() });
  } catch (e) {
    const attempts = a.attempts + 1, giveUp = attempts >= MAX_ATTEMPTS;
    await ref.update({ status: giveUp ? "failed" : "retrying", attempts, lastError: String(e).slice(0, 500),
      nextAttemptAt: Timestamp.fromMillis(Date.now() + (attempts === 1 ? 1 : 5) * MIN) });
  }
}
export const onDeliveryCreated = onDocumentCreated({ region: REGION, document: "users/{uid}/shares/{sid}/deliveries/{id}", secrets: SECRETS },
  (e) => (e.data ? deliver(e.data.ref) : undefined));
export const retryDeliveries = onSchedule({ region: REGION, schedule: "every 5 minutes", secrets: SECRETS }, async () => {
  const s = await db.collectionGroup("deliveries").where("status", "in", OPEN).where("nextAttemptAt", "<=", Timestamp.now()).get();
  for (const d of s.docs) await deliver(d.ref);
});
