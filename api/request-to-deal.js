// /api/request-to-deal.js
// Creates a Bitrix DEAL in your "Invoice Request" stage.
// Accepts JSON or x-www-form-urlencoded payloads.
// Understands both the old WP names (billing_*, container_type[], qty[]) and simpler names.

function splitName(full) {
  if (!full) return { first: "", last: "" };
  const parts = String(full).trim().split(/\s+/);
  const first = parts.shift() || "";
  const last = parts.join(" ");
  return { first, last };
}
function normalizePhone(s) {
  if (!s) return "";
  return String(s).replace(/[^\d+]/g, "");
}
function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

export default async function handler(req, res) {
  // CORS, allow your domains
  const origins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const reqOrigin = req.headers.origin || "";
  const allow = origins.length === 0 || origins.includes("*") || origins.includes(reqOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", allow ? (origins.includes("*") ? "*" : reqOrigin) : origins[0] || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Env
  const base = process.env.B24_WEBHOOK_BASE;
  const DEAL_CATEGORY_ID = Number(process.env.DEAL_CATEGORY_ID || 0); // optional
  const DEAL_STAGE_ID = process.env.DEAL_STAGE_ID || "";             // required
  if (!base || !DEAL_STAGE_ID) return res.status(500).json({ error: "Missing Bitrix env vars" });

  // Parse body, tolerate JSON or x-www-form-urlencoded
  let b = {};
  try {
    b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    const raw = typeof req.body === "string" ? req.body : "";
    try { b = Object.fromEntries(new URLSearchParams(raw)); } catch { b = {}; }
  }

  // Names and contact
  const { first: splitFirst, last: splitLast } = splitName(b.name || b.billing_first_name || "");
  const firstName = b.first_name || b.billing_first_name || splitFirst || "";
  const lastName  = b.last_name  || b.billing_last_name  || splitLast  || "";
  const email     = b.email || b.billing_email || "";
  const phone     = normalizePhone(b.phone || b.billing_phone);

  // Addresses and logistics
  const billing_address = b.billing_address_1 || b.billing_address || "";
  const billing_city    = b.billing_city || "";
  const billing_state   = b.billing_state || b.province || "";
  const billing_postal  = b.billing_postcode || b.postal_code || "";
  const delivery_method = b.delivery_method || "";
  const pickup_point    = b.pickup_point || "";
  const door_direction  = b.door_direction || "";
  const site_contact    = b.site_contact || "";

  // Line items: accept container_type[] + qty[] or single values
  const ctWP  = b["container_type[]"];
  const qWP   = b["qty[]"];
  const ctArr = asArray(ctWP ?? b.container_type);
  const qArr  = asArray(qWP ?? b.qty);
  const items = [];
  const n = Math.max(ctArr.length, qArr.length);
  for (let i = 0; i < n; i++) {
    const t = (ctArr[i] || "").toString().trim();
    const q = (qArr[i] || "").toString().trim();
    if (t && t.toLowerCase() !== "none") {
      items.push(`${q || "1"} x ${t}`);
    }
  }

  // Other fields
  const message   = b.order_note || b.message || "Invoice Request";
  const company   = b.company || b.company_name || "";
  const page_url  = b.page_url || b.pageUrl || b._wp_http_referer || "";
  const lead_id   = Number(b.lead_id || 0) || undefined;

  // UTMs
  const utm_source   = b.utm_source   || b.utmSource   || "";
  const utm_medium   = b.utm_medium   || b.utmMedium   || "";
  const utm_campaign = b.utm_campaign || b.utmCampaign || "";
  const utm_term     = b.utm_term     || b.utmTerm     || "";
  const utm_content  = b.utm_content  || b.utmContent  || "";

  // Minimal validation
  if (!email && !phone) return res.status(400).json({ error: "Email or phone required" });

  // Bitrix helper
  async function b24(method, payload, attempt = 0) {
    const r = await fetch(`${base}${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const status = r.status;
    const j = await r.json().catch(() => ({}));
    if ((status === 429 || status >= 500) && attempt < 3) {
      await new Promise(rs => setTimeout(rs, Math.pow(2, attempt) * 300));
      return b24(method, payload, attempt + 1);
    }
    if (j.error) throw new Error(`${j.error}: ${j.error_description || ""}`);
    return j.result;
  }

  // 1) Find or create Contact
  let contactId = 0;
  try {
    const type = email ? "EMAIL" : "PHONE";
    const values = email ? [email] : [phone];
    const dup = await b24("crm.duplicate.findbycomm", { entity_type: "CONTACT", type, values });
    if (dup?.CONTACT?.length) {
      contactId = dup.CONTACT[0];
    } else {
      const contactFields = {
        NAME: firstName || "",
        LAST_NAME: lastName || "",
        EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : undefined,
        PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : undefined,
        COMPANY_TITLE: company || undefined
      };
      contactId = await b24("crm.contact.add", { fields: contactFields });
    }
  } catch {
    contactId = 0;
  }

  // 2) Build Deal fields
  const comments = [
    "Form: invoice_request",
    message ? `Message: ${message}` : null,
    company ? `Company: ${company}` : null,
    items.length ? `Items:\n- ${items.join("\n- ")}` : null,
    delivery_method ? `Delivery method: ${delivery_method}` : null,
    pickup_point ? `Pickup point: ${pickup_point}` : null,
    door_direction ? `Door direction: ${door_direction}` : null,
    site_contact ? `Site contact: ${site_contact}` : null,
    billing_address ? `Billing address: ${billing_address}` : null,
    billing_city ? `Billing city: ${billing_city}` : null,
    billing_state ? `Billing province: ${billing_state}` : null,
    billing_postal ? `Billing postal: ${billing_postal}` : null,
    page_url ? `Page: ${page_url}` : null,
    utm_source ? `UTM Source: ${utm_source}` : null,
    utm_medium ? `UTM Medium: ${utm_medium}` : null,
    utm_campaign ? `UTM Campaign: ${utm_campaign}` : null,
    utm_term ? `UTM Term: ${utm_term}` : null,
    utm_content ? `UTM Content: ${utm_content}` : null
  ].filter(Boolean).join("\n");

  const dealFields = {
    TITLE: "Invoice Request",
    CATEGORY_ID: DEAL_CATEGORY_ID || undefined, // your Deals pipeline ID, optional if single pipeline
    STAGE_ID: DEAL_STAGE_ID,                    // your “Invoice Request” status code
    CONTACT_ID: contactId || undefined,
    SOURCE_ID: "WEB",
    COMMENTS: comments,
    LEAD_ID: lead_id
  };

  try {
    const dealId = await b24("crm.deal.add", { fields: dealFields, params: { REGISTER_SONET_EVENT: "Y" } });
    return res.status(200).json({ status: "created", id: dealId });
  } catch (e) {
    return res.status(502).json({ error: "Bitrix error", message: String(e.message || e) });
  }
}

