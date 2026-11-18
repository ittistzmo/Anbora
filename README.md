# ANBORA backend (Module 1)

Deploy: `npm i -g firebase-tools && firebase login && cd backend/functions && npm i && cd .. && \
firebase functions:secrets:set WA_TOKEN WA_APP_SECRET SMS_AUTHKEY && firebase deploy --only firestore,functions`
(you will be prompted for WA_PHONE_NUMBER_ID, WA_TEMPLATE_NAME, WA_VERIFY_TOKEN, SMS_TEMPLATE_ID). Requires the Blaze plan.

Alert status flow: queued → sending → sent_to_provider → delivered (WhatsApp webhook only) | retrying → failed | cancelled.
SMS stays "sent_to_provider" unless you add your gateway's delivery-report webhook; the app must never show it as delivered.

## Module 2 additions (location)
New callables: `shareLocation`, `triggerSos`, `updateSharedLocation`, `setSharePaused`, `stopSharing`. `recordCheckin` now accepts optional `location` + `shareWithContacts`.
New params: `WA_LOCATION_TEMPLATE`, `SMS_LOCATION_TEMPLATE_ID`. Both templates take 4 variables:
`ANBORA: {{1}} has sent {{2}}. Location: {{3}}. Time: {{4}}. Please try contacting them.` (get this wording approved / DLT-registered).
Contacts receive a one-time Google Maps link per share. There is no live viewer page for contacts yet; background updates are stored server-side only.
