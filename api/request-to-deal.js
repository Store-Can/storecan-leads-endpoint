// /api/request-to-deal.js
// Creates a Bitrix DEAL in "Invoice Request" stage.
// Works with Tally webhook payloads AND classic form posts.
// Lets the Deal be created even if email and phone are empty.

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

// Map Tally webhook => flat object with our expected keys
function mapFromTally(b) {
  if (!b || !b.data || !Array.isArray(b.data.fields)) return null;

  const out = {};
  for (const f of b.data.fields) {
    const label = String(f.key || f.label || "").toLowerCase();
    const raw = f.value;
    const val = typeof raw === "object" && raw && "label" in raw ? raw.label
              : Array.isArray(raw) ? raw.join(", ")
              : raw;

    const set = (...names) => names.forEach(n => { if (!(n in out)) out[n] = val; });

    if (label.includes("first") && label.includes("name")) set("billing_first_name","name");
    else if (label === "name") set("name","billing_first_name");
    else if (label.includes("email")) set("billing_email","email");
    else if (label.includes("site contact name")) set("site_contact_name");
    else if (label.includes("site contact phone")) set("site_contact_phone");
    else if (label.includes("phone")) set("billing_phone","phone");
    else if (label.includes("company")) set("company","company_name");
    else if (label.includes("address")) set("billing_address_1","billing_address");
    else if (label.includes("pickup city") || label.includes("depot")) set("pickup_city","depot_location","depot_city","pickup_point");
    else if (label.includes("city")) set("billing_city","city");
    else if (label.includes("province") || label.includes("state")) set("billing_state","province");
    else if (label.includes("postal") || label.includes("postcode") || label.includes("zip")) set("billing_postcode","postal_code");
    else if (label.includes("delivery method")) set("delivery_method");
    else if (label.includes("door direction")) set("door_direction");
    else if (label.includes("container") && label.includes("type")) set("container_type");
    else if (label === "qty" || label.includes("quantity")) set("qty","quantity");
    else if (label.includes("condition")) set("condition");
    else if (label.includes("note") || label.includes("message")) set("order_note","message");
  }

  // Hidden fields from Tally
  if (b.data.hidden) Object.assign(out, b.data.hidden);
  if (b.data.url && !out.page_url) out.page_url = b.data.url;

  return out;
}

export default async function handler(req, res) {
  // CORS
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

  const base = process.env.B24_WEBHOOK_BASE;
  const DEAL_CATEGORY_ID = Number(process.env.DEAL_CATEGORY_ID || 0);
  const DEAL_STAGE_ID = process.env.DEAL_STAGE_ID || "";
  if (!base || !DEAL_STAGE_ID) return res.status(500).json({ error: "Missing Bitrix env vars" });

  // Parse body
  let b = {};
  try {
    b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    const raw = typeof req.body === "string" ? req.body : "";
    try { b = Object.fromEntries(new URLSearchParams(raw)); } catch { b = {}; }
  }

  // If this is a Tally webhook, remap it
  const maybeTally = mapFromTally(b);
  if (maybeTally) b = maybeTally;

  // Names and contact
  const { first: splitFirst, last: splitLast } = splitName(b.name || b.billing_first_name || "");
  const firstName = b.first_name || b.billing_first_name || splitFirst || "";
  const lastName  = b.last_name  || b.billing_last_name  || splitLast  || "";
  const email     = b.email || b.billing_email || "";
  const phone     = normalizePhone(b.phone || b.billing_phone);

  // Addresses
  const billing_address = b.billing_address_1 || b.billing_address || "";
  const billing_city    = b.billing_city || "";
  const billing_state   = b.billing_state || b.province || "";
  const billing_postal  = b.billing_postcode || b.postal_code || "";

  // Delivery vs Pickup
  const delivery_method_raw = b.delivery_method || "";
  const delivery_method = delivery_method_raw.toLowerCase();
  const pickup_city = b.pickup_city || b.depot_location || b.depot_city || b.pickup_point || "";
  const site_contact_name  = b.site_contact_name || b.site_contact || "";
  const site_contact_phone = normalizePhone(b.site_contact_phone || "");

  // Line items
  const ctArr = asArray(b["container_type[]"] ?? b.container_type ?? b.container_size);
  const qArr  = asArray(b["qty[]"] ?? b.qty ?? b.quantity);
  const cond  = b.condition || "";
  const items = [];
  const n = Math.max(ctArr.length, qArr.length, 1);
  for (let i = 0; i < n; i++) {
    const t = (ctArr[i] ?? ctArr[0] ?? "").toString().trim();
    const q = (qArr[i]  ?? qArr[0]  ?? "").toString().trim();
    if (t && t.toLowerCase() !== "none") {
      const line = [q || "1", "x", t, cond ? `(${cond})` : ""].filter(Boolean).join(" ");
      items.push(line);
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

  // Helper to call Bitrix
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

  // Find or create Contact only if we have email or phone
  let contactId = 0;
  if (email || phone) {
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
  }

  // Build Comments
  const parts = [
    "Form: invoice_request",
    message ? `Message: ${message}` : null,
    company ? `Company: ${company}` : null,
    (email || phone) ? null : "No email or phone provided",
    items.length ? `Items:\n- ${items.join("\n- ")}` : null,
    `Delivery method: ${delivery_method_raw || "n/a"}`
  ];
  if (delivery_method === "delivery") {
    parts.push(
      site_contact_name ? `Site contact name: ${site_contact_name}` : "Site contact name: n/a",
      site_contact_phone ? `Site contact phone: ${site_contact_phone}` : "Site contact phone: n/a"
    );
  }
  if (delivery_method === "pickup") {
    parts.push(pickup_city ? `Pickup depot: ${pickup_city}` : "Pickup depot: n/a");
  }
  parts.push(
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
  );
  const comments = parts.filter(Boolean).join("\n");

  // Create Deal
  const fields = {
    TITLE: "Invoice Request",
    CATEGORY_ID: DEAL_CATEGORY_ID || undefined,
    STAGE_ID: DEAL_STAGE_ID,
    CONTACT_ID: contactId || undefined,
    SOURCE_ID: "WEB",
    COMMENTS: comments,
    LEAD_ID: lead_id
  };

  try {
    const id = await b24("crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "Y" } });
    return res.status(200).json({ status: "created", id });
  } catch (e) {
    return res.status(502).json({ error: "Bitrix error", message: String(e.message || e) });
  }
}
