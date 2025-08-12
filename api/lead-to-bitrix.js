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
  // CORS so your Framer site can call this
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // Support both single-field "name" and separate first_name, last_name
    const split = splitName(b.name);
    const firstName = b.first_name || split.first || "";
    const lastName = b.last_name || split.last || "";

    // Accept Province and City
    const province = b.province || "";
    const city = b.city || "";

    // Accept UTMs with multiple casings, and page URL
    const utm_source   = b.utm_source   || b.utmSource   || "";
    const utm_medium   = b.utm_medium   || b.utmMedium   || "";
    const utm_campaign = b.utm_campaign || b.utmCampaign || "";
    const utm_term     = b.utm_term     || b.utmTerm     || "";
    const utm_content  = b.utm_content  || b.utmContent  || "";
    const page_url     = b.page_url     || b.pageUrl     || b.pageURL || "";

    const email = b.email || "";
    const phone = normalizePhone(b.phone);

    // Basic validation
    if (!email && !phone) {
      return res.status(400).json({ error: "Email or phone required" });
    }

    // Build Bitrix lead fields
    const comments = [
      b.message ? `Message: ${b.message}` : null,
      b.container_size ? `Container size: ${b.container_size}` : null,
      b.condition ? `Condition: ${b.condition}` : null,
      b.postal_code ? `Delivery postal code: ${b.postal_code}` : null,
      city ? `City: ${city}` : null,
      province ? `Province: ${province}` : null,
      page_url ? `Page: ${page_url}` : null
    ].filter(Boolean).join("\n");

    const fields = {
      TITLE: "Website lead",
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

    // Optional mapping into Bitrix address fields. Uncomment if you want.
    // fields.ADDRESS_CITY = city;
    // fields.ADDRESS_REGION = province;
    // fields.ADDRESS_POSTAL_CODE = b.postal_code || "";

    // Call Bitrix to create the lead
    const url = `${process.env.B24_WEBHOOK_BASE}crm.lead.add.json`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: "Y" } })
    });
    const j = await r.json();

    if (j.error) {
      return res.status(502).json({ error: j.error, description: j.error_description });
    }
    return res.status(200).json({ status: "created", id: j.result });

  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
}
