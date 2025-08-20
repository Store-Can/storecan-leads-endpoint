// /api/quote-to-deal.js  – INVOICE REQUEST (Invoice pipeline)
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

  const looksLikeUUID = v => typeof v === "string" && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v);

  // best-effort flattener that resolves choice IDs to human labels
  function toFlat(payload) {
    const flat = {};
    const counts = {};

    const set = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      let k = norm(key);
      if (flat[k]) {
        counts[k] = (counts[k] || 1) + 1;
        k = `${k}_${counts[k]}`;
      } else {
        counts[k] = 1;
      }
      flat[k] = typeof val === "string" ? val : JSON.stringify(val);
    };

    // try to resolve a field's value into a readable label
    const toLabel = (f) => {
      let v = f?.value;

      // arrays
      if (Array.isArray(v)) {
        const labels = v.map(x => (x && typeof x === "object")
          ? (x.label || x.name || x.text || x.value || x.choice)
          : x).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }

      // single object
      if (v && typeof v === "object") {
        return v.label || v.name || v.text || v.value || v.choice || JSON.stringify(v);
      }

      // value may be an id, with choices listed separately
      const allChoices = f?.options?.choices || f?.options || f?.choices || [];
      if (allChoices && (v || v === 0)) {
        const id = Array.isArray(v) ? v[0] : v;
        const hit = allChoices.find(o =>
          o?.id === id || o?.value === id || o?.key === id || o === id
        );
        if (hit) return hit.label || hit.name || hit.value || String(id);
      }

      // if value looks like UUID and we have a text label on field, prefer that
      if (looksLikeUUID(v) && f?.label) return f.label;

      // fallback to raw text
      return (v === undefined || v === null) ? "" : String(v);
    };

    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      const d = obj.data || obj;

      // Tally style: data.fields[]
      if (Array.isArray(d.fields)) {
        for (const f of d.fields) {
          const label = f.label || f.key || f.id || "";
          const val = toLabel(f);
          set(label, val);
          // keep raw too for debugging if different
          if (val !== f?.value && (typeof f?.value === "string" || typeof f?.value === "number")) set(`${label} (raw)`, String(f.value));
        }
      }

      // Typeform style answers[]
      const answers = d.answers || d.form_response?.answers || [];
      if (Array.isArray(answers)) {
        for (const a of answers) {
          const label = a.field?.label || a.label || a.id || "";
          const val = a.email || a.phone || a.text ||
            (a.choice && (a.choice.label || a.choice.value)) ||
            (a.choices && (a.choices.labels?.join(", ") || a.choices.values?.join(", "))) ||
            a.value || a.answer || "";
          set(label, val);
        }
      }

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

  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");
  const toInt = v => {
    const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : undefined;
  };

  try {
    const base = process.env.B24_WEBHOOK_BASE;
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

    // Map exactly to the email content
    const containerType1 = pick("container type", "container_type", "container size");
    const quantity1      = toInt(pick("quantity", "quantity_1", "qty", "count"));

    const containerType2 = pick("add a second container type to this order", "add_a_second_container_type_to_this_order", "container type 2", "second container type");
    const quantity2      = toInt(flat["quantity_2"]) || toInt(flat["quantity_3"]) || toInt(flat["quantity_4"]) || undefined;

    const orderComments  = pick("comments", "order_comments");
    const name           = pick("name", "full_name");
    const email          = pick("email", "your_email");
    const phone          = cleanPhone(pick("phone number", "phone_number", "phone"));

    const billingAddr    = pick("billing address", "billing_address");
    const province       = pick("province", "province_state");
    const city           = pick("city", "billing_city");

    const methodRaw      = pick("method", "delivery_method");
    const method         = (methodRaw || "").toLowerCase() === "delivery" ? "Delivery" : (methodRaw || "").toLowerCase() === "pickup" ? "Pickup" : methodRaw;

    const deliveryAddr   = pick("delivery address/map pin/coordinates", "delivery_address", "map pin", "map_pin", "coordinates");

    const doorsRaw       = pick("container doors direction for pickup", "doors_direction_for_pickup", "doors_direction");
    const doorsDirection = (() => {
      const v = (doorsRaw || "").toString().toLowerCase();
      if (!v) return "";
      if (looksLikeUUID(doorsRaw)) return ""; // avoid dumping UUID if mapping failed
      if (["doors to the cab", "cab", "front", "to_cab", "doors_to_cab"].includes(v)) return "Doors to the Cab";
      if (["doors to the back", "back", "rear", "to_back", "doors_to_back"].includes(v)) return "Doors to the Back";
      return doorsRaw;
    })();

    const siteName       = pick("site contact name", "site_name");
    const sitePhone      = cleanPhone(pick("site contact phone number", "site_phone"));
    const deliveryNotes  = pick("delivery comments", "delivery_comments", "delivery_notes");

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
          NAME: name || (phone ? "Caller" : "Visitor"),
          OPENED: "Y",
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : []
        }
      });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) Compose comments exactly like the email snapshot
    const lines = [];
    lines.push("Form: invoice request");

    if (containerType1 && !looksLikeUUID(containerType1)) { lines.push(""); lines.push("Container type"); lines.push(containerType1); }
    if (quantity1)      { lines.push(""); lines.push("Quantity"); lines.push(String(quantity1)); }

    if (containerType2 && !looksLikeUUID(containerType2)) { lines.push(""); lines.push("Add a second container type to this order"); lines.push(containerType2); }
    if (quantity2)      { lines.push(""); lines.push("Quantity"); lines.push(String(quantity2)); }

    if (orderComments)  { lines.push(""); lines.push("Comments"); lines.push(orderComments); }

    if (name)           { lines.push(""); lines.push("Name"); lines.push(name); }
    if (email)          { lines.push(""); lines.push("Email"); lines.push(email); }
    if (phone)          { lines.push(""); lines.push("Phone number"); lines.push(phone); }

    if (billingAddr)    { lines.push(""); lines.push("Billing address"); lines.push(billingAddr); }
    if (province && !looksLikeUUID(province)) { lines.push(""); lines.push("Province"); lines.push(province); }
    if (city)           { lines.push(""); lines.push("City"); lines.push(city); }

    if (method && !looksLikeUUID(method)) { lines.push(""); lines.push("Method"); lines.push(method); }

    if (deliveryAddr)   { lines.push(""); lines.push("Delivery address/Map Pin/Coordinates"); lines.push(deliveryAddr); }

    if (doorsDirection) { lines.push(""); lines.push("Container doors direction for pickup"); lines.push(doorsDirection); }

    if (siteName)       { lines.push(""); lines.push("Site contact name"); lines.push(siteName); }
    if (sitePhone)      { lines.push(""); lines.push("Site contact phone number"); lines.push(sitePhone); }

    if (deliveryNotes)  { lines.push(""); lines.push("Delivery comments"); lines.push(deliveryNotes); }

    const commentsBlock = lines.join("
");

    // 3) Create deal in Invoice pipeline
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? `C${CATEGORY_ID}:NEW`;
    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || "WEB";

    const titleBits = [
      containerType1 && !looksLikeUUID(containerType1) ? containerType1 : "Invoice request",
      quantity1 ? `x${quantity1}` : null,
      city || province
    ].filter(Boolean).join(" | ");

    const dealAdd = await b24("crm.deal.add", {
      fields: {
        TITLE: titleBits.slice(0, 250) || "Invoice request",
        CATEGORY_ID: CATEGORY_ID,
        STAGE_ID: STAGE_ID,
        ASSIGNED_BY_ID: assignedById || undefined,
        CONTACT_ID: contactId || undefined,
        SOURCE_ID: sourceId,
        SOURCE_DESCRIPTION: "new.storecan.ca",
        COMMENTS: commentsBlock
      }
    });

    if (dealAdd?.result) return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    return res.status(500).json({ error: "Failed to create deal", raw: dealAdd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
