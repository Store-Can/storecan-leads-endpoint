// /api/lead-to-bitrix.js

// Split a single "name" into first and last
function splitName(full) {
  if (!full) return { first: "", last: "" };
  const parts = String(full).trim().split(/\s+/);
  const first = parts.shift() || "";
  const last = parts.join(" ");
  return { first, last };
}

// Normalize phone to digits and leading plus
function normalizePhone(s) {
  if (!s) return "";
  return String(s).replace(/[^\d+]/g, "");
}

export default async function handler(req, res) {
  // CORS, supports one or many origins via ALLOWED_ORIGINS or ALLOWED_ORIGIN
  const origins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const reqOrigin = req.headers.origin || "";
  const allowThisOrigin = origins.length === 0 || origins.includes("*") || origins.includes(reqOrigin);

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", allowThisOrigin ? (origins.includes("*") ? "*" : reqOrigin) : origins[0] || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Parse body, tolerate JSON or x-www-form-urlencoded
  let b = {};
  try {
    b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    const raw = typeof req.body === "string" ? req.body : "";
    try {
      b = Object.fromEntries(new URLSearchParams(raw));
    } catch {
      b = {};
    }
  }

  // Name handling, supports single "name" or first_name/last_name
  const { first: splitFirst, last: splitLast } = splitName(b.name);
  const firstName = b.first_name || splitFirst || "";
  const lastName = b.last_name || splitLast || "";

  // Common fields
  const province = b.province || "";
  const city = b.city || "";
  const postal_code = b.postal_code || "";

  // UTMs, accept multiple casings
  const utm_source   = b.utm_source   || b.utmSource   || "";
  const utm_medium   = b.utm_medium   || b.utmMedium   || "";
  const utm_campaign = b.utm_campaign || b.utmCampaign || "";
  const utm_term     = b.utm_term     || b.utmTerm     || "";
  const utm_content  = b.utm_content  || b.utmContent  || "";
  const page_url     = b.page_url     || b.pageUrl     || b.pageURL || "";

  const email = b.email || "";
  const phone = normalizePhone(b.phone);

  // Form tagging and call request logic
  const form_name = b.form_name || "";
  const messageText = b.message || (form_name === "call_request" ? "Call Request" : "");

  // Basic validation
  if (!email && !phone) {
    return res.status(400).json({ error: "Email or phone required" });
  }

  // Build Comments
  const comments = [
    form_name ? `Form: ${form_name}` : null,
    messageText ? `Message: ${messageText}` : null,
    b.container_size ? `Container size: ${b.container_size}` : null,
    b.condition ? `Condition: ${b.condition}` : null,
    postal_code ? `Delivery postal code: ${postal_code}` : null,
    city ? `City: ${city}` : null,
    province ? `Province: ${province}` : null,
    page_url ? `Page: ${page_url}` : null
  ].filter(Boolean).join("\n");

  // Lead title, switch to Call Request when that form is used
  const leadTitle = form_name === "call_request" ? "Call Request" : "Website lead";

  // Bitrix Lead fields
  const fields = {
    TITLE: leadTitle,
    NAME: firstName,
    LAST_NAME: lastName,
    SOURCE_ID: "WEB",
    COMMENTS: comments,
    UTM_SOURCE: utm_source,
    UTM_MEDIUM: utm_medium,
    UTM_CAMPAIGN: utm_campaign,
    UTM_TERM: utm_term,
    UTM_CONTENT: utm_content
  };
  if (email) fields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: "WORK" }];

  // Optional address mapping
  // fields.ADDRESS_CITY = city;
  // fields.ADDRESS_REGION = province;
  // fields.ADDRESS_POSTAL_CODE = postal_code;

  const base = process.env.B24_WEBHOOK_BASE;
  if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

  try {
    const r = await fetch(`${base}crm.lead.add.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: "Y" } })
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) {
      return res.status(502).json({ error: j.error, description: j.error_description || "" });
    }
    return res.status(200).json({ status: "created", id: j.result });
  } catch {
    return res.status(500).json({ error: "Internal error" });
  }
}
