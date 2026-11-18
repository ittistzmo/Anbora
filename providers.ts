import { defineSecret, defineString } from "firebase-functions/params";

export const WA_TOKEN = defineSecret("WA_TOKEN");
export const WA_APP_SECRET = defineSecret("WA_APP_SECRET");
export const SMS_AUTHKEY = defineSecret("SMS_AUTHKEY");
export const WA_PHONE_NUMBER_ID = defineString("WA_PHONE_NUMBER_ID");
export const WA_TEMPLATE_NAME = defineString("WA_TEMPLATE_NAME");
export const WA_VERIFY_TOKEN = defineString("WA_VERIFY_TOKEN");
export const SMS_TEMPLATE_ID = defineString("SMS_TEMPLATE_ID"); // DLT-approved template via gateway
export const SECRETS = [WA_TOKEN, WA_APP_SECRET, SMS_AUTHKEY];

/** WhatsApp Cloud API approved template. Template body variables: {{1}} user name, {{2}} last confirmed time. */
export async function sendWhatsApp(to: string, vars: [string, string]): Promise<string> {
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID.value()}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: to.replace(/\D/g, ""), type: "template",
      template: { name: WA_TEMPLATE_NAME.value(), language: { code: "en" },
        components: [{ type: "body", parameters: vars.map((text) => ({ type: "text", text })) }] },
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`WhatsApp: ${JSON.stringify(j.error ?? j)}`);
  return j.messages[0].id as string;
}

/** SMS via MSG91 Flow API (DLT). Verify the request shape against your gateway's current docs. */
export async function sendSms(to: string, vars: [string, string]): Promise<string> {
  const r = await fetch("https://control.msg91.com/api/v5/flow", {
    method: "POST",
    headers: { authkey: SMS_AUTHKEY.value(), "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: SMS_TEMPLATE_ID.value(), short_url: "0",
      recipients: [{ mobiles: to.replace(/\D/g, ""), var1: vars[0], var2: vars[1] }] }),
  });
  const j: any = await r.json();
  if (!r.ok || j.type !== "success") throw new Error(`SMS: ${JSON.stringify(j)}`);
  return String(j.message); // gateway request id (accepted, NOT delivered)
}
