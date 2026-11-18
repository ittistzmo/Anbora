import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp, DocumentReference } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { createHmac, timingSafeEqual } from "crypto";
import { sendWhatsApp, sendSms, SECRETS, WA_APP_SECRET, WA_VERIFY_TOKEN } from "./providers";

initializeApp();
const db = getFirestore();
const REGION = "asia-south1";
const MIN = 60_000, HOUR = 3_600_000;
const CFG = { escalationMs: 24 * HOUR, reminderMs: 10 * MIN, maxAttempts: 5, backoffMin: [2, 5, 15, 30, 60] };
const OPEN = ["queued", "retrying", "sending"];

const log = (uid: string, type: string, data: object = {}) =>
  db.collection(`users/${uid}/events`).add({ type, ...data, at: FieldValue.serverTimestamp() });
const clampInterval = (m: unknown) => Math.min(240, Math.max(15, Number(m) || 60));

// ---------- Callable: create server-controlled user doc ----------
export const initUser = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid; if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  const ref = db.doc(`users/${uid}`);
  if ((await ref.get()).exists) return { created: false };
  const d = req.data ?? {};
  const now = Timestamp.now();
  await ref.set({
    name: String(d.name ?? "").slice(0, 80), phone: String(d.phone ?? ""), language: d.language ?? "en",
    timezone: d.timezone ?? "Asia/Kolkata", fcmTokens: [], checkinIntervalMinutes: 60,
    monitoringEnabled: true, lastConfirmedAt: now, // sign-up counts as first confirmation
    nextPromptAt: Timestamp.fromMillis(now.toMillis() + HOUR), reminderDueAt: null, escalatedFor: null,
  });
  await log(uid, "user_created");
  return { created: true, serverTime: now.toMillis() };
});

// ---------- Callable: record a check-in (server time is the source of truth) ----------
export const recordCheckin = onCall({ region: REGION }, async (req) => {
  const uid = req.auth?.uid; if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  const { category, confirmSafe } = req.data ?? {};
  if (!["WORK", "TEMPLE", "HOUSE", "OTHER"].includes(category)) throw new HttpsError("invalid-argument", "Bad category");
  const safe = confirmSafe === true;
  const now = Timestamp.now();
  const ref = db.doc(`users/${uid}`);
  const upd: Record<string, unknown> = { lastCategory: category };
  if (safe) Object.assign(upd, { lastConfirmedAt: now, reminderDueAt: null, escalatedFor: null });
  else if (category === "HOUSE" || category === "OTHER") upd.reminderDueAt = Timestamp.fromMillis(now.toMillis() + CFG.reminderMs);
  await ref.update(upd);
  await db.collection(`users/${uid}/checkins`).add({ category, confirmedSafe: safe, createdAt: now });
  if (safe) { // stop escalation: cancel any alert not yet sent
    const open = await db.collection(`users/${uid}/alerts`).where("status", "in", OPEN).get();
    await Promise.all(open.docs.map((d) => d.ref.update({ status: "cancelled", cancelledAt: now })));
  }
  await log(uid, safe ? "safe_confirmed" : "category_selected", { category });
  return { serverTime: now.toMillis(), safeConfirmed: safe };
});

// ---------- Push helper ----------
async function push(uid: string, tokens: string[], type: "checkin_prompt" | "checkin_reminder") {
  if (!tokens.length) return;
  const body = type === "checkin_prompt" ? "Ippo enga irukeenga? Tap to check in." : "Innum reply pannala. Please tap “I'm Safe ❤️”.";
  const res = await getMessaging().sendEachForMulticast({
    tokens, data: { type }, notification: { title: "ANBORA 💛", body },
    android: { priority: "high", notification: { channelId: "checkins" } },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default", category: "CHECKIN" } } },
  });
  const dead = tokens.filter((_, i) => !res.responses[i].success &&
    /registration-token-not-registered|invalid-argument/.test(res.responses[i].error?.code ?? ""));
  if (dead.length) await db.doc(`users/${uid}`).update({ fcmTokens: FieldValue.arrayRemove(...dead) });
  await log(uid, `${type}_sent`, { ok: res.successCount, failed: res.failureCount });
}

// ---------- Scheduler: prompts, reminders, escalation (runs without the app) ----------
export const tick = onSchedule({ region: REGION, schedule: "every 5 minutes", timeoutSeconds: 300 }, async () => {
  const now = Timestamp.now();
  const [due, rem, over] = await Promise.all([
    db.collection("users").where("nextPromptAt", "<=", now).get(),
    db.collection("users").where("reminderDueAt", "<=", now).get(),
    db.collection("users").where("lastConfirmedAt", "<=", Timestamp.fromMillis(now.toMillis() - CFG.escalationMs)).get(),
  ]);
  for (const d of due.docs) {
    const u = d.data(); if (!u.monitoringEnabled) continue;
    await d.ref.update({ nextPromptAt: Timestamp.fromMillis(now.toMillis() + clampInterval(u.checkinIntervalMinutes) * MIN) });
    await push(d.id, u.fcmTokens ?? [], "checkin_prompt");
  }
  for (const d of rem.docs) { // HOUSE/OTHER selected but not confirmed safe: repeat every 10 min
    const u = d.data(); if (!u.monitoringEnabled) continue;
    await d.ref.update({ reminderDueAt: Timestamp.fromMillis(now.toMillis() + CFG.reminderMs) });
    await push(d.id, u.fcmTokens ?? [], "checkin_reminder");
  }
  for (const d of over.docs) if (d.data().monitoringEnabled) await escalate(d.ref);
});

// Atomic claim + alert creation. Deterministic alert IDs and create() make duplicates impossible.
async function escalate(ref: DocumentReference) {
  const cutoff = Date.now() - CFG.escalationMs;
  const out = await db.runTransaction(async (tx) => {
    const u = (await tx.get(ref)).data()!;
    const lc = u.lastConfirmedAt as Timestamp;
    if (lc.toMillis() > cutoff || u.escalatedFor?.toMillis() === lc.toMillis()) return null;
    const contacts = await tx.get(ref.collection("contacts").where("consentStatus", "==", "granted"));
    const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: u.timezone || "Asia/Kolkata" }).format(lc.toDate());
    let n = 0;
    for (const c of contacts.docs) {
      const cd = c.data();
      for (const ch of ["whatsapp", "sms"] as const) {
        if (cd[ch] === false) continue;
        tx.create(ref.collection("alerts").doc(`${lc.toMillis()}_${c.id}_${ch}`), {
          uid: ref.id, contactId: c.id, channel: ch, phone: cd.phone, userName: u.name, lastConfirmedText: when,
          confirmedAtMillis: lc.toMillis(), status: "queued", attempts: 0,
          nextAttemptAt: Timestamp.now(), createdAt: FieldValue.serverTimestamp(),
        });
        n++;
      }
    }
    tx.update(ref, { escalatedFor: lc, escalatedAt: FieldValue.serverTimestamp() });
    return n;
  });
  if (out !== null) await log(ref.id, "escalation_started", { alerts: out });
}

// ---------- Delivery with retry ----------
async function deliver(ref: DocumentReference) {
  const a = await db.runTransaction(async (tx) => {
    const a = (await tx.get(ref)).data();
    if (!a || !OPEN.includes(a.status) || a.nextAttemptAt.toMillis() > Date.now()) return null;
    tx.update(ref, { status: "sending", nextAttemptAt: Timestamp.fromMillis(Date.now() + 10 * MIN) }); // lease
    return a;
  });
  if (!a) return;
  const u = (await db.doc(`users/${a.uid}`).get()).data();
  if (!u || u.lastConfirmedAt.toMillis() !== a.confirmedAtMillis) return void ref.update({ status: "cancelled" });
  try {
    const vars: [string, string] = [a.userName, a.lastConfirmedText];
    const id = a.channel === "whatsapp" ? await sendWhatsApp(a.phone, vars) : await sendSms(a.phone, vars);
    await ref.update({ status: "sent_to_provider", providerMessageId: id, attempts: a.attempts + 1, sentAt: FieldValue.serverTimestamp() });
    await log(a.uid, "alert_sent_to_provider", { channel: a.channel });
  } catch (e) {
    const attempts = a.attempts + 1, giveUp = attempts >= CFG.maxAttempts;
    await ref.update({ status: giveUp ? "failed" : "retrying", attempts, lastError: String(e).slice(0, 500),
      nextAttemptAt: Timestamp.fromMillis(Date.now() + CFG.backoffMin[Math.min(attempts - 1, 4)] * MIN) });
    await log(a.uid, giveUp ? "alert_failed" : "alert_retry_scheduled", { channel: a.channel });
  }
}
export const onAlertCreated = onDocumentCreated({ region: REGION, document: "users/{uid}/alerts/{id}", secrets: SECRETS },
  (e) => e.data ? deliver(e.data.ref) : undefined);
export const retryAlerts = onSchedule({ region: REGION, schedule: "every 5 minutes", secrets: SECRETS }, async () => {
  const s = await db.collectionGroup("alerts").where("status", "in", OPEN).where("nextAttemptAt", "<=", Timestamp.now()).get();
  for (const d of s.docs) await deliver(d.ref);
});

// ---------- WhatsApp webhook: only here may an alert become "delivered" ----------
export const whatsappWebhook = onRequest({ region: REGION, secrets: SECRETS }, async (req, res) => {
  if (req.method === "GET") {
    return void (req.query["hub.verify_token"] === WA_VERIFY_TOKEN.value()
      ? res.status(200).send(req.query["hub.challenge"]) : res.sendStatus(403));
  }
  const sig = String(req.get("x-hub-signature-256") ?? "");
  const exp = "sha256=" + createHmac("sha256", WA_APP_SECRET.value()).update(req.rawBody).digest("hex");
  if (sig.length !== exp.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return void res.sendStatus(401);
  const map: Record<string, string> = { sent: "sent_to_provider", delivered: "delivered", read: "delivered", failed: "failed" };
  for (const en of req.body.entry ?? []) for (const ch of en.changes ?? []) for (const st of ch.value?.statuses ?? []) {
    const q = await db.collectionGroup("alerts").where("providerMessageId", "==", st.id).limit(1).get();
    if (q.empty || !map[st.status]) continue;
    const cur = q.docs[0].data().status;
    if (cur === "delivered" && st.status === "sent") continue; // never downgrade
    await q.docs[0].ref.update({ status: map[st.status], deliveryUpdatedAt: FieldValue.serverTimestamp() });
  }
  res.sendStatus(200);
});
