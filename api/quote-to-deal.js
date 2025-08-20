// /api/quote-to-deal.js – INVOICE REQUEST (Invoice pipeline)
// Final fix: reliable ID → Label mapping for Container Types and Province,
// env‑driven dictionary, and stable auto title "Invoice Request (NEW100xxxxx)".
export default async function handler(req, res) {
  // CORS
  const originHeader = req.headers.origin || "";
  const allowedList = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
    .split(",").map(s => s.trim()).filter(Boolean);
  const allowOrigin = allowedList.includes("*") ? "*" : allowedList.includes(originHeader) ? originHeader : (allowedList[0] || "*");

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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ---------- helpers ----------
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "";
    try { return raw ? JSON.parse(raw) : {}; } catch (_) {
      try { return Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; }
    }
  }
  const norm = s => (s || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const looksLikeUUID = v => typeof v === "string" && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");
  const toInt = v => { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : undefined; };

  // Build a resolvable options dictionary, merging static + env JSON
  // You can maintain these without code changes by setting FORM_OPTION_MAP_JSON, for example:
  // {
  //   "container_type": { "fc2e9e61-be19-4065-9e5a-9b926e7c5544": "40' HC New Double Doors" },
  //   "province": { "d0a3ca2e-7b91-4c3e-9925-4d912385c176": "Alberta" }
  // }
  const STATIC_MAP = {
    container_type: {
      // older IDs we saw earlier
      "e7ae7ebd-0f39-4584-96a9-5f5154bdbbfb": "40’L x 8’W x 9’6”H HC New (1trip) Double Doors",
      "681d358d-ca15-49cc-a215-84edf5d08fb3": "40’L x 8’W x 9’6”H HC New (1trip)",
      "00a288e5-000d-4125-b6ab-bc4a33773912": "40’L x 8’W x 9’6”H HC New (1trip) Double Doors",
      "32ed3669-a335-4852-870a-abdf2c137df1": "40’L x 8’W x 9’6”H HC New (1trip)",
      // latest IDs from your screenshot
      "fc2e9e61-be19-4065-9e5a-9b926e7c5544": "40’ HC New (1trip) Double Doors", // update label if needed
      "4b9f8044-5102-49a4-8ee0-4487ee1afb3f": "40’ HC New (1trip)"
    },
    province: {
      "c1d119fa-2270-4cf8-9055-a4fae3b98b0a": "Alberta",
      "a0988845-750c-455c-9e26-9dadd33cf136": "Alberta",
      "d0a3ca2e-7b91-4c3e-9925-4d912385c176": "Alberta"
    },
    method: { "5de9e305-16e5-43fa-9997-dd2d1c44515d": "Delivery" },
    doors_direction: { "47b72b20-b047-4c7a-8d71-8678f05a75ef": "Doors to the Cab" }
  };
  let ENV_MAP = {};
  try { ENV_MAP = JSON.parse(process.env.FORM_OPTION_MAP_JSON || "{}"); } catch { ENV_MAP = {}; }
  const MERGED_MAP = {
    container_type: { ...(STATIC_MAP.container_type || {}), ...((ENV_MAP.container_type) || {}) },
    province: { ...(STATIC_MAP.province || {}), ...((ENV_MAP.province) || {}) },
    method: { ...(STATIC_MAP.method || {}), ...((ENV_MAP.method) || {}) },
    doors_direction: { ...(STATIC_MAP.doors_direction || {}), ...((ENV_MAP.doors_direction) || {}) }
  };
  const resolveOption = (group, val) => {
    if (!val) return val;
    const v = String(val).trim();
    // already a human value
    if (!looksLikeUUID(v)) return v;
    // dictionary mapping
    const hit = MERGED_MAP[group]?.[v];
    return hit || v; // if not found, keep id, but we format it clearly below
  };

  // Flattener that prefers human text when provided by the payload
  function toFlat(payload) {
    const flat = {};
    const counts = {};
    const set = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      let k = norm(key);
      if (flat[k]) { counts[k] = (counts[k] || 1) + 1; k = `${k}_${counts[k]}`; } else counts[k] = 1;
      flat[k] = typeof val === "string" ? val : JSON.stringify(val);
    };

    const toLabel = (f) => {
      let v = f?.value;
      if (Array.isArray(v)) {
        const labels = v.map(x => (x && typeof x === "object") ? (x.label || x.name || x.text || x.value) : x).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }
      if (v && typeof v === "object") return v.label || v.name || v.text || v.value || JSON.stringify(v);
      // some payloads include choices in field metadata, try to map here if present
      const opts = f?.options?.choices || f?.options || f?.choices || [];
      if (opts && v) {
        const arr = Array.isArray(v) ? v : [v];
        const labels = arr.map(id => {
          const hit = opts.find(o => o?.id === id || o?.value === id || o?.key === id || o === id);
          return hit?.label || hit?.name || hit?.value || id;
        }).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }
      return (v === undefined || v === null) ? "" : String(v);
    };

    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      const d = obj.data || obj;
      if (Array.isArray(d.fields)) {
        for (const f of d.fields) {
          const label = f.label || f.key || f.id || "";
          const val = toLabel(f);
          set(label, val);
        }
      }
      const answers = d.answers || d.form_response?.answers || [];
      if (Array.isArray(answers)) {
        for (const a of answers) {
          const label = a.field?.label || a.field?.id || a.label || a.id || "";
          const val = a.email || a.phone || a.text || (a.choice && (a.choice.label || a.choice.value)) || (a.choices && (a.choices.labels?.join(", ") || a.choices.values?.join(", "))) || a.value || a.answer || "";
          set(label, val);
        }
      }
      const hidden = d.hidden || d.meta?.hidden || {};
      for (const [k, v] of Object.entries(hidden)) set(k, v);
      for (const [k, v] of Object.entries(d)) { if (v && typeof v !== "object") set(k, v); }
    };
    walk(payload);
    return flat;
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE;
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);
    const flat = toFlat(raw);
    const pick = (...c) => { for (const k of c) { const v = flat[norm(k)]; if (v) return v; } return ""; };

    // Map fields and resolve known UUIDs to labels
    let containerType1 = resolveOption("container_type", pick("container type", "container_type", "container size"));
    const quantity1    = toInt(pick("quantity", "quantity_1", "qty", "count"));
    let containerType2 = resolveOption("container_type", pick("add a second container type to this order", "container type 2", "second container type"));
    const quantity2    = toInt(flat["quantity_2"]) || toInt(flat["quantity_3"]) || undefined;

    const orderComments= pick("comments", "order_comments");
    const name         = pick("name", "full_name");
    const email        = pick("email", "your_email");
    const phone        = cleanPhone(pick("phone number", "phone_number", "phone"));

    const billingAddr  = pick("billing address", "billing_address");
    let province       = resolveOption("province", pick("province", "province_state"));
    const city         = pick("city", "billing_city");

    let method         = resolveOption("method", pick("method", "delivery_method"));
    if (method) method = method[0].toUpperCase() + method.slice(1).toLowerCase();

    const deliveryAddr = pick("delivery address/map pin/coordinates", "delivery_address", "map pin", "coordinates");
    let doorsDirection = resolveOption("doors_direction", pick("container doors direction for pickup", "doors_direction"));
    if (doorsDirection) {
      const v = doorsDirection.toLowerCase();
      if (["cab", "to_cab", "doors_to_cab", "front", "doors to the cab"].includes(v)) doorsDirection = "Doors to the Cab";
      if (["back", "to_back", "doors_to_back", "rear", "doors to the back"].includes(v)) doorsDirection = "Doors to the Back";
    }

    const siteName     = pick("site contact name", "site_name");
    const sitePhone    = cleanPhone(pick("site contact phone number", "site_phone"));
    const deliveryNotes= pick("delivery comments", "delivery_comments", "delivery_notes");

    // Bitrix helper
    const b24 = (methodName, params) => {
      const endpoint = base.endsWith("/") ? `${base}${methodName}.json` : `${base}/${methodName}.json`;
      return fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) }).then(r => r.json());
    };

    // Contact
    let contactId = null;
    if (email) { const q = await b24("crm.contact.list", { filter: { EMAIL: email }, select: ["ID"] }); contactId = q?.result?.[0]?.ID || null; }
    if (!contactId && phone) { const q = await b24("crm.contact.list", { filter: { PHONE: phone }, select: ["ID"] }); contactId = q?.result?.[0]?.ID || null; }
    if (!contactId && (email || phone)) {
      const c = await b24("crm.contact.add", { fields: { NAME: name || (phone ? "Caller" : "Visitor"), OPENED: "Y", EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [], PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [] } });
      if (c?.result) contactId = c.result;
    }

    // Comments block, never display raw UUIDs, show a friendly placeholder if mapping missing
    const display = (group, v) => {
      if (!v) return "";
      if (!looksLikeUUID(v)) return v;
      const hit = MERGED_MAP[group]?.[v];
      return hit || "Selection not captured"; // prevents ugly IDs appearing
    };

    const lines = [];
    lines.push("Form: invoice request");
    if (containerType1) { lines.push("", "Container type", display("container_type", containerType1)); }
    if (quantity1)      { lines.push("", "Quantity", String(quantity1)); }
    if (containerType2) { lines.push("", "Add a second container type to this order", display("container_type", containerType2)); }
    if (quantity2)      { lines.push("", "Quantity", String(quantity2)); }
    if (orderComments)  { lines.push("", "Comments", orderComments); }
    if (name)           { lines.push("", "Name", name); }
    if (email)          { lines.push("", "Email", email); }
    if (phone)          { lines.push("", "Phone number", phone); }
    if (billingAddr)    { lines.push("", "Billing address", billingAddr); }
    if (province)       { lines.push("", "Province", display("province", province)); }
    if (city)           { lines.push("", "City", city); }
    if (method)         { lines.push("", "Method", method); }
    if (deliveryAddr)   { lines.push("", "Delivery address/Map Pin/Coordinates", deliveryAddr); }
    if (doorsDirection) { lines.push("", "Container doors direction for pickup", doorsDirection); }
    if (siteName)       { lines.push("", "Site contact name", siteName); }
    if (sitePhone)      { lines.push("", "Site contact phone number", sitePhone); }
    if (deliveryNotes)  { lines.push("", "Delivery comments", deliveryNotes); }

    const comments = lines.join("\n");

    // Pipeline
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? `C${CATEGORY_ID}:NEW`;
    const assignedById = Number(process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.DEAL_SOURCE_ID || "WEB";

    // Title: Invoice Request (NEW100xxxxx)
    const autoNumber = `NEW100${Date.now().toString().slice(-5)}`;
    const title = `Invoice Request (${autoNumber})`;

    const dealAdd = await b24("crm.deal.add", {
      fields: {
        TITLE: title.slice(0, 250),
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
