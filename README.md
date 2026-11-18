# ANBORA backend (Module 1)

Deploy: `npm i -g firebase-tools && firebase login && cd backend/functions && npm i && cd .. && \
firebase functions:secrets:set WA_TOKEN WA_APP_SECRET SMS_AUTHKEY && firebase deploy --only firestore,functions`
(you will be prompted for WA_PHONE_NUMBER_ID, WA_TEMPLATE_NAME, WA_VERIFY_TOKEN, SMS_TEMPLATE_ID). Requires the Blaze plan.

Alert status flow: queued → sending → sent_to_provider → delivered (WhatsApp webhook only) | retrying → failed | cancelled.
SMS stays "sent_to_provider" unless you add your gateway's delivery-report webhook; the app must never show it as delivered.
