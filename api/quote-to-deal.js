// /api/quote-to-deal.js  — INVOICE REQUEST (Invoice pipeline)
export default async function handler(req, res) {
  // CORS allow-list
  const originHeader = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
    .split(",").map(s => s.trim()).filter(Boolean);
  const allowOrigin =
    allowedList.includes("*") ? "*" :
    allowedList.includes(originHeader) ? originHeader :
    allowedList[0] || "*";

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    return res.status(200).json({ ok: true, method: "GET", stage: "stub-get" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Read body as JSON or x-www-form-urlencoded
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "";
    try { return raw ? JSON.parse(raw) : {}; } catch (_) {
      try { return Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; }
    }
  }

  // Utility: normalize a key into snake_case
  const norm = s => (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  // Utility: flatten many possible webhook shapes into { key: value }
  function toFlat(payload) {
    const flat = {};

    // helper to set value under multiple candidate keys
    const set = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      const k = norm(key);
      if (!flat[k]) flat[k] = typeof val === "string" ? val : JSON.stringify(val);
    };

    // walk the object for useful shapes
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;

      // Tally common shapes
      const d = obj.data || obj;

      // 1) Tally v2: data.fields[] with { key, label, type, value }
      if (Array.isArray(d.fields)) {
        for (const f of d.fields) {
          const label = f.label || f.key || f.id || "";
          let val = f.value;
          // some controls nest value types
          if (val && typeof val === "object") {
            val = val.email || val.phone || val.text || val.choice || val.name || val.value || val.label || JSON.stringify(val);
          }
          set(label, val);
          set(f.key, val);
        }
      }

      // 2) Alternative shapes: data.answers[] or form_response.answers[] (Typeform-like)
      const answers = d.answers || d.form_response?.answers || [];
      if (Array.isArray(answers)) {
        for (const a of answers) {
          const label = a.field?.label || a.field?.id || a.label || a.id || "";
          const val = a.email || a.phone || a.text || a.choice?.label || a.value || a.answer || JSON.stringify(a);
          set(label, val);
          if (a.field?.id) set(a.field.id, val);
        }
      }

      // 3) hidden params
      const hidden = d.hidden || d.meta?.hidden || {};
      for (const [k, v] of Object.entries(hidden)) set(k, v);

      // 4) also copy any top-level primitives
      for (const [k, v] of Object.entries(d)) {
        if (v && typeof v !== "object") set(k, v);
      }
    };

    walk(payload);
    return flat;
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE; // https://.../rest/USER/TOKEN[/]
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);
    const flat = toFlat(raw);

    // helper to pick the first non-empty value from candidate keys
    function pick(...cands) {
      for (const c of cands) {
        const v = flat[norm(c)];
        if (v) return v;
      }
      return "";
    }

    // Normalized fields from Tally (and flat JSON fallback)
    const firstName = pick("firstName", "first_name");
    const lastName  = pick("lastName", "last_name");
    const fullName  = pick("fullName", "full_name", "your_name", "name");
    const phone     = pick("phone", "phone_number", "your_phone");
    const email     = pick("email", "your_email");
    const message   = pick("message", "comments", "notes", "description");
    const city      = pick("city", "your_city", "location_city", "location");
    const province  = pick("province", "state", "province_state", "region");
    const size      = pick("container_size", "containerSize", "size", "container", "what_size");
    const condition = pick("condition", "container_condition");
    const page_url  = pick("page_url", "page");

    const utm_source   = pick("utm_source");
    const utm_medium   = pick("utm_medium");
    const utm_campaign = pick("utm_campaign");
    const utm_term     = pick("utm_term");
    const utm_content  = pick("utm_content");

    const name = fullName || [firstName, lastName].filter(Boolean).join(" ").trim() || (phone ? "Caller" : "Visitor");

    // Helper: safe Bitrix call (handles trailing slash)
    const b24 = (method, params) => {
      const endpoint = base.endsWith("/") ? `${base}${method}.json` : `${base}/${method}.json`;
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params || {})
      }).then(r => r.json());
    };

    // 1) Find or create contact
    let contactId = null;

    if (email) {
      const byEmail = await b24("crm.contact.list", { filter: { EMAIL: email }, select: ["ID"] });
      contactId = byEmail?.result?.[0]?.ID || null;
    }
    if (!contactId && phone) {
      const byPhone = await b24("crm.contact.list", { filter: { PHONE: phone }, select: ["ID"] });
      contactId = byPhone?.result?.[0]?.ID || null;
    }

    if (!contactId && (email || phone)) {
      const contactCreate = await b24("crm.contact.add", {
        fields: {
          NAME: name,
          OPENED: "Y",
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : []
        }
      });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) Build comments
    const comments = [
      "Form: invoice request",
      message && `Message: ${message}`,
      size && `Container: ${size}`,
      condition && `Condition: ${condition}`,
      (city || province) && `Location: ${[city, province].filter(Boolean).join(", ")}`,
      email && `Email: ${email}`,
      phone && `Phone: ${phone}`,
      page_url && `Page: ${page_url}`,
      (utm_source || utm_medium || utm_campaign || utm_term || utm_content) &&
        `UTM: source=${utm_source || ""}, medium=${utm_medium || ""}, campaign=${utm_campaign || ""}, term=${utm_term || ""}, content=${utm_content || ""}`
    ].filter(Boolean).join("\n");

    // 3) Create deal in Invoice pipeline (env-driven)
    const CATEGORY_ID = Number(
      process.env.INVOICE_CATEGORY_ID ??
      process.env.QUOTE_CATEGORY_ID ?? 6
    );
    const STAGE_ID =
      process.env.INVOICE_STAGE_ID ??
      process.env.QUOTE_STAGE_ID ??
      (CATEGORY_ID === 0 ? "NEW" : `C${CATEGORY_ID}:NEW`);

    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || process.env.DEAL_SOURCE_ID || "WEB";

    const titleBits = [name || phone || "Invoice request", size || "", city || province || ""]
      .filter(Boolean)
      .join(" | ");

    const dealAdd = await b24("crm.deal.add", {
      fields: {
        TITLE: `Invoice Request: ${titleBits}`.slice(0, 250),
        CATEGORY_ID: CATEGORY_ID,
        STAGE_ID: STAGE_ID,
        ASSIGNED_BY_ID: assignedById || undefined,
        CONTACT_ID: contactId || undefined,
        SOURCE_ID: sourceId,
        SOURCE_DESCRIPTION: "new.storecan.ca",
        COMMENTS: comments
      }
    });

    if (dealAdd?.result) {
      return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    }
    return res.status(500).json({ error: "Failed to create deal", raw: dealAdd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
