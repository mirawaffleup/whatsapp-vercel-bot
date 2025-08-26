// api/webhook.js
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// --- ENV ---
const {
  META_VERIFY_TOKEN,        // any string you choose (for webhook verification)
  META_TOKEN,               // WhatsApp Cloud API permanent or temp token
  META_PHONE_NUMBER_ID,     // from WhatsApp Getting Started
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,    // use Service Role to allow inserts securely in serverless
  GEMINI_API_KEY,
  OWNER_WHATSAPP            // your personal WhatsApp number in international format, e.g. "8801XXXXXXXXX"
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// --- Helpers ---
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${META_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("Send WA failed:", t);
  }
}

// very lightweight prompt to classify intent and draft reply
async function callGemini(system, user) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" + GEMINI_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: `${system}\n\nUSER:\n${user}` }] }
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
    })
  });
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
}

function parseBlock(jsonLike) {
  // try to extract a JSON block from LLM text
  try {
    const start = jsonLike.indexOf("{");
    const end = jsonLike.lastIndexOf("}");
    if (start >= 0 && end >= 0) {
      return JSON.parse(jsonLike.slice(start, end + 1));
    }
  } catch (e) {}
  return null;
}

async function summarizeThread(messagesForCustomer) {
  const content = messagesForCustomer.map(m =>
    `${m.direction === "inbound" ? "Customer" : "You"}: ${m.message_text}`
  ).join("\n");

  const sys = `You are a concise CRM assistant. Produce:
- "summary": 2-4 sentences summarizing the conversation.
- "insights": an object with keys {sentiment, topic, urgency, actionable_points[]}.

Return pure JSON.`;
  const out = await callGemini(sys, content);
  return parseBlock(out) || { summary: "", insights: {} };
}

async function classifyAndReply(text) {
  const sys = `You are a triage agent for a small food brand's WhatsApp.
Classify the customer's message into one of: ["info_request","complaint","recommendation","other"].
Provide:
- "intent"
- "confidence" (0-1)
- "reply" (a short polite reply fitting the intent; if "other", ask for clarification)

Assume the brand sells waffles, drinks; keep replies friendly and brief.
Return pure JSON.`;

  const out = await callGemini(sys, text);
  const json = parseBlock(out);
  if (!json) {
    return { intent: "other", confidence: 0.0, reply: "Could you share a bit more detail so I can help you better?" };
  }
  return json;
}

// --- HTTP handler ---
export default async function handler(req, res) {
  if (req.method === "GET") {
    // Webhook verification
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const body = req.body;
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const msg = changes?.value?.messages?.[0];
    const contact = changes?.value?.contacts?.[0];

    if (!msg || msg.type !== "text") {
      return res.status(200).json({ ok: true, note: "non-text or no msg" });
    }

    const phone = contact?.wa_id;
    const name = contact?.profile?.name || null;
    const text = msg?.text?.body?.trim() || "";
    const from = msg.from; // sender phone

    // upsert customer
    let { data: cust, error: custErr } = await supabase
      .from("customers")
      .upsert({ phone, name, last_seen_at: new Date().toISOString() }, { onConflict: "phone" })
      .select()
      .single();
    if (custErr) throw custErr;

    // store inbound message
    await supabase.from("messages").insert({
      customer_id: cust.id,
      direction: "inbound",
      message_text: text,
      raw: body
    });

    // classify
    const { intent, confidence, reply } = await classifyAndReply(text);

    // low confidence => notify owner and hold
    if (confidence < 0.6 || intent === "other") {
      await sendWhatsAppText(OWNER_WHATSAPP, `⚠️ New message needs attention from ${name || phone}:\n"${text}"`);
      await sendWhatsAppText(from, "Thanks for your message! A team member will get back to you shortly.");
    } else {
      // auto-reply
      await sendWhatsAppText(from, reply);

      // store outbound
      await supabase.from("messages").insert({
        customer_id: cust.id,
        direction: "outbound",
        message_text: reply
      });
    }

    // summarize recent thread (last 30 messages)
    const { data: msgs } = await supabase
      .from("messages")
      .select("direction,message_text,created_at")
      .eq("customer_id", cust.id)
      .order("created_at", { ascending: true })
      .limit(30);

    const summary = await summarizeThread(msgs || []);
    await supabase
      .from("conversation_summaries")
      .upsert({
        customer_id: cust.id,
        last_summary: summary.summary || "",
        last_insights: summary.insights || {},
        updated_at: new Date().toISOString()
      });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // always 200 so Meta doesn't retry forever
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "2mb" }
  }
};
