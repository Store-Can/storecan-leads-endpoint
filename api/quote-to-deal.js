// /api/quote-to-deal.js  – INVOICE REQUEST (Invoice pipeline) – hotfix
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

  // Robust flattener with broad choice mapping
  function toFlat(payload) {
    const flat = {};
    const counts = {};

    const set = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      let k = norm(key);
      if (flat[k]) { counts[k] = (counts[k] || 1) + 1; k = `${k}_${counts[k]}`; } else { counts[k] = 1; }
      flat[k] = typeof val === "string" ? val : JSON.stringify(val);
    };

    // Given a field and raw value, try to produce a label
    const mapChoice = (f, rawVal) => {
      const pools = [];
      if (Array.isArray(f?.options?.choices)) pools.push(f.options.choices);
      if (Array.isArray(f?.options)) pools.push(f.options);
      if (Array.isArray(f?.choices)) pools.push(f.choices);
      for (const pool of pools) {
        const hit = pool.find(o => o && (o.id === rawVal || o.value === rawVal || o.key === rawVal || o === rawVal));
        if (hit) return hit.label || hit.name || hit.value || hit.text || String(rawVal);
      }
      return undefined;
    };

    const toLabel = (f) => {
      const v = f?.value;
      if (Array.isArray(v)) {
        const vals = v.map(x => (x && typeof x === "object") ? (x.label || x.name || x.text || x.value) : x);
        if (vals.filter(Boolean).length) return vals.join(", ");
      }
      if (v && typeof v === "object") {
        return v.label || v.name || v.text || v.value || JSON.stringify(v);
      }
      if (v !== undefined && v !== null) {
        // Try map against choices
        const mapped = mapChoice(f, v);
        if (mapped) return mapped;
        return String(v);
      }
      return "";
    };

    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      const d = obj.data || obj;

      if (Array.isArray(d.fields)) {
        for (const f of d.fields) {
          const label = f.label || f.key || f.id || "";
          const valResolved = toLabel(f);
          set(label, valResolved);
          // keep raw if it looks like UUID and we resolved something
          if (looksLikeUUID(f?.value) && valResolved && valResolved !== f.value) set(`${label} (id)`, String(f.value));
        }
      }

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

      for (const [k, v] of Object.entries(d)) {
        if (v && typeof v !== "object") set(k, v);
      }
    };

    walk(payload);
    return flat;
  }

  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");
  const toInt = v => { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : undefined; };

  try {
    const base = process.env.B24_WEBHOOK_BASE;
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);
    const flat = toFlat(raw);

    const pick = (...cands) => { for (const c of cands) { const v = flat[norm(c)]; if (v) return v; } return ""; };

    // Fields
    const containerType1 = pick("container type", "container_type", "container size");
    const quantity1      = toInt(pick("quantity", "quantity_1", "qty", "count"));

    const containerType2 = pick("add a second container type to this order", "add_a_second_container_type_to_this_order", "container type 2");
    const quantity2      = toInt(flat["quantity_2"]) || toInt(flat["quantity_3"]) || undefined;

    const orderComments  = pick("comments", "order_comments");

    const name           = pick("name", "full_name");
    const email          = pick("email", "your_email");
    const phone          = cleanPhone(pick("phone number", "phone_number", "phone"));

    const billingAddr    = pick("billing address", "billing_address");
    const province       = pick("province", "province_state");
    const city           = pick("city", "billing_city");

    const method         = pick("method", "delivery_method");
    const deliveryAddr   = pick("delivery address/map pin/coordinates", "delivery_address", "map pin");

    const doorsDirection = pick("container doors direction for pickup", "doors_direction_for_pickup", "doors_direction");
    const siteName       = pick("site contact name", "site_name");
    const sitePhone      = cleanPhone(pick("site contact phone number", "site_phone"));
    const deliveryNotes  = pick("delivery comments", "delivery_comments", "delivery_notes");

    // Bitrix helper with visibility logs
    const b24 = async (methodName, params) => {
      const endpoint = base.endsWith("/") ? `${base}${methodName}.json` : `${base}/${methodName}.json`;
      const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) });
      const j = await r.json();
      if (j?.error) console.error("B24 error", methodName, j);
      return j;
    };

    // 1) Find or create contact
    let contactId = null;
    if (email) { const byEmail = await b24("crm.contact.list", { filter: { EMAIL: email }, select: ["ID"] }); contactId = byEmail?.result?.[0]?.ID || null; }
    if (!contactId && phone) { const byPhone = await b24("crm.contact.list", { filter: { PHONE: phone }, select: ["ID"] }); contactId = byPhone?.result?.[0]?.ID || null; }
    if (!contactId && (email || phone)) {
      const contactCreate = await b24("crm.contact.add", { fields: { NAME: name || (phone ? "Caller" : "Visitor"), OPENED: "Y", EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [], PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [] } });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) Comments block, never output UUIDs as values
    const show = v => looksLikeUUID(v) ? "" : v;
    const lines = [];
    lines.push("Form: invoice request");

    if (show(containerType1)) { lines.push(""); lines.push("Container type"); lines.push(show(containerType1)); }
    if (quantity1)            { lines.push(""); lines.push("Quantity"); lines.push(String(quantity1)); }

    if (show(containerType2)) { lines.push(""); lines.push("Add a second container type to this order"); lines.push(show(containerType2)); }
    if (quantity2)            { lines.push(""); lines.push("Quantity"); lines.push(String(quantity2)); }

    if (orderComments)        { lines.push(""); lines.push("Comments"); lines.push(orderComments); }

    if (name)                 { lines.push(""); lines.push("Name"); lines.push(name); }
    if (email)                { lines.push(""); lines.push("Email"); lines.push(email); }
    if (phone)                { lines.push(""); lines.push("Phone number"); lines.push(phone); }

    if (billingAddr)          { lines.push(""); lines.push("Billing address"); lines.push(billingAddr); }
    if (show(province))       { lines.push(""); lines.push("Province"); lines.push(show(province)); }
    if (city)                 { lines.push(""); lines.push("City"); lines.push(city); }

    if (show(method))         { lines.push(""); lines.push("Method"); lines.push(show(method)); }

    if (deliveryAddr)         { lines.push(""); lines.push("Delivery address/Map Pin/Coordinates"); lines.push(deliveryAddr); }

    if (show(doorsDirection)) { lines.push(""); lines.push("Container doors direction for pickup"); lines.push(show(doorsDirection)); }

    if (siteName)             { lines.push(""); lines.push("Site contact name"); lines.push(siteName); }
    if (sitePhone)            { lines.push(""); lines.push("Site contact phone number"); lines.push(sitePhone); }

    if (deliveryNotes)        { lines.push(""); lines.push("Delivery comments"); lines.push(deliveryNotes); }

    const comments = lines.join("
");

    // 3) Create deal, always with a safe title
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? `C${CATEGORY_ID}:NEW`;
    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || "WEB";

    const titleParts = [];
    titleParts.push(show(containerType1) || "Invoice request");
    if (quantity1) titleParts.push(`x${quantity1}`);
    if (city || show(province)) titleParts.push(city || show(province));

    const dealAdd = await b24("crm.deal.add", { fields: { TITLE: titleParts.join(" | ").slice(0, 250), CATEGORY_ID: CATEGORY_ID, STAGE_ID: STAGE_ID, ASSIGNED_BY_ID: assignedById || undefined, CONTACT_ID: contactId || undefined, SOURCE_ID: sourceId, SOURCE_DESCRIPTION: "new.storecan.ca", COMMENTS: comments } });

    if (dealAdd?.result) return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    return res.status(500).json({ error: "Failed to create deal", raw: dealAdd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
