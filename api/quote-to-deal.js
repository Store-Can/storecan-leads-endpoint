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

  // normalize to snake_case keys
  const norm = s => (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  // try to convert Tally/Typeform shapes into readable labels
  function toFlat(payload) {
    const flat = {};
    const set = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      const k = norm(key);
      if (!flat[k]) flat[k] = typeof val === "string" ? val : JSON.stringify(val);
    };

    // best-effort extractor for a field value to human-readable
    const toLabel = (f) => {
      let v = f?.value;

      // arrays: list of objects with label/name/value, or list of raw ids
      if (Array.isArray(v)) {
        const labels = v.map(x =>
          (x && typeof x === "object")
            ? (x.label || x.name || x.text || x.value || x.choice || x.email || x.phone)
            : x
        ).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }

      // single object with label/name/value
      if (v && typeof v === "object") {
        return v.label || v.name || v.text || v.value || v.choice || v.email || v.phone || JSON.stringify(v);
      }

      // some payloads keep selected ids in value, with options listed separately
      const opts = f?.options?.choices || f?.options || f?.choices || [];
      if (opts && v) {
        const asArray = Array.isArray(v) ? v : [v];
        const labels = asArray.map(id => {
          const hit = opts.find(o =>
            o?.id === id || o?.key === id || o?.value === id || o === id
          );
          return hit?.label || hit?.name || hit?.value || hit || id;
        }).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }

      // typeform-like choices
      if (f?.choices?.labels?.length) return f.choices.labels.join(", ");

      // fallback
      return (v === undefined || v === null) ? "" : String(v);
    };

    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      const d = obj.data || obj;

      // Tally v2: data.fields[] with { key, label, value, options/choices }
      if (Array.isArray(d.fields)) {
        for (const f of d.fields) {
          const label = f.label || f.key || f.id || "";
          const val = toLabel(f);
          set(label, val);
          if (f.key) set(f.key, val);
          if (f.id) set(f.id, val);
        }
      }

      // answers[] variants
      const answers = d.answers || d.form_response?.answers || [];
      if (Array.isArray(answers)) {
        for (const a of answers) {
          const label = a.field?.label || a.field?.id || a.label || a.id || "";
          const val =
            a.email || a.phone || a.text ||
            (a.choice && (a.choice.label || a.choice.value)) ||
            (a.choices && (a.choices.labels?.join(", ") || a.choices.values?.join(", "))) ||
            a.value || a.answer || JSON.stringify(a);
          set(label, val);
          if (a.field?.id) set(a.field.id, val);
        }
      }

      // hidden params
      const hidden = d.hidden || d.meta?.hidden || {};
      for (const [k, v] of Object.entries(hidden)) set(k, v);

      // copy any top-level primitives
      for (const [k, v] of Object.entries(d)) {
        if (v && typeof v !== "object") set(k, v);
      }
    };

    walk(payload);
    return flat;
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE; // https://.../rest/<USER>/<TOKEN>[/]
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);
    const flat = toFlat(raw);
    const pick = (...cands) => {
      for (const c of cands) {
        const v = flat[norm(c)];
        if (v) return v;
      }
      return "";
    };

    // Core customer and order fields
    const firstName = pick("firstName", "first_name");
    const lastName  = pick("lastName", "last_name");
    const fullName  = pick("fullName", "full_name", "your_name", "name");
    const email     = pick("email", "your_email");
    const phone     = pick("phone", "phone_number", "your_phone");
    const province  = pick("province", "state", "province_state", "region");
    const city      = pick("city", "your_city", "location_city", "billing_city") || pick("location");

    const containerType = pick("container type", "container_type", "container", "container size", "type");
    const quantity      = pick("quantity", "qty", "count");
    const billingAddr   = pick("billing address", "billing_address", "address");

    // Delivery / Pickup specifics
    const method        = (pick("method", "delivery_method", "ship_method") || "").toLowerCase(); // "pickup" or "delivery"
    const pickupDepot   = pick("location", "pickup_location", "depot", "pickup depot", "pickup_branch");
    const doorsDirection= pick("container doors direction for pickup", "doors_direction", "doors");
    const siteName      = pick("site contact name", "site_name", "sitecontactname");
    const sitePhone     = pick("site contact phone number", "site_phone", "sitecontactphone");
    const deliveryNotes = pick("delivery comments", "delivery_notes", "deliverycomments");

    const message       = pick("comments", "message", "notes", "description", "order_comments");

    const utm_source    = pick("utm_source");
    const utm_medium    = pick("utm_medium");
    const utm_campaign  = pick("utm_campaign");
    const utm_term      = pick("utm_term");
    const utm_content   = pick("utm_content");

    const name = fullName || [firstName, lastName].filter(Boolean).join(" ").trim() || (phone ? "Caller" : "Visitor");

    // Bitrix helper
    const b24 = (methodName, params) => {
      const endpoint = base.endsWith("/") ? `${base}${methodName}.json` : `${base}/${methodName}.json`;
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

    // 2) Build detailed comments
    const lines = [];
    lines.push("Form: invoice request");

    if (containerType || quantity) lines.push(`Order: ${[containerType, quantity && `x${quantity}`].filter(Boolean).join(" ")}`);
    if (billingAddr) lines.push(`Billing address: ${billingAddr}`);
    if (province || city) lines.push(`Location: ${[city, province].filter(Boolean).join(", ")}`);

    if (method === "pickup") {
      lines.push("Method: Pickup");
      if (pickupDepot) lines.push(`Pickup depot: ${pickupDepot}`);
      if (doorsDirection) lines.push(`Doors direction: ${doorsDirection}`);
    } else if (method === "delivery") {
      lines.push("Method: Delivery");
      if (siteName)  lines.push(`Site contact: ${siteName}`);
      if (sitePhone) lines.push(`Site contact phone: ${sitePhone}`);
      if (doorsDirection) lines.push(`Doors direction: ${doorsDirection}`);
      if (deliveryNotes) lines.push(`Delivery notes: ${deliveryNotes}`);
    } else if (method) {
      lines.push(`Method: ${method}`);
    }

    if (message) lines.push(`Message: ${message}`);
    if (email)   lines.push(`Email: ${email}`);
    if (phone)   lines.push(`Phone: ${phone}`);

    if (utm_source || utm_medium || utm_campaign || utm_term || utm_content) {
      lines.push(
        `UTM: source=${utm_source || ""}, medium=${utm_medium || ""}, campaign=${utm_campaign || ""}, term=${utm_term || ""}, content=${utm_content || ""}`
      );
    }

    const comments = lines.join("\n");

    // 3) Create deal in Invoice pipeline (env-driven)
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? process.env.QUOTE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? process.env.QUOTE_STAGE_ID ?? (CATEGORY_ID === 0 ? "NEW" : `C${CATEGORY_ID}:NEW`);
    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || process.env.DEAL_SOURCE_ID || "WEB";

    const titleBits = [
      containerType || "Invoice request",
      quantity && `x${quantity}`,
      city || province
    ].filter(Boolean).join(" | ");

    const dealAdd = await b24("crm.deal.add", {
      fields: {
        TITLE: titleBits.slice(0, 250),
        CATEGORY_ID: CATEGORY_ID,
        STAGE_ID: STAGE_ID,
        ASSIGNED_BY_ID: assignedById || undefined,
        CONTACT_ID: contactId || undefined,
        SOURCE_ID: sourceId,
        SOURCE_DESCRIPTION: "new.storecan.ca",
        COMMENTS: comments
      }
    });

    if (dealAdd?.result) return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    return res.status(500).json({ error: "Failed to create deal", raw: dealAdd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
