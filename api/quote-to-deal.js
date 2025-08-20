// /api/quote-to-deal.js – INVOICE REQUEST (Invoice pipeline) with ID → Label mapping and auto‑numbered titles
export default async function handler(req, res) {
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

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "";
    try { return raw ? JSON.parse(raw) : {}; } catch (_) {
      try { return Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; }
    }
  }

  const norm = s => (s || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  // Extendable UUID mapping table
  const idMap = {
    // Container types
    "00a288e5-000d-4125-b6ab-bc4a33773912": "40’L x 8’W x 9’6”H HC New (1trip) Double Doors",
    "32ed3669-a335-4852-870a-abdf2c137df1": "40’L x 8’W x 9’6”H HC New (1trip)",
    "e7ae7ebd-0f39-4584-96a9-5f5154bdbbfb": "40’L x 8’W x 9’6”H HC New (1trip) Double Doors",
    "681d358d-ca15-49cc-a215-84edf5d08fb3": "40’L x 8’W x 9’6”H HC New (1trip)",

    // Provinces
    "c1d119fa-2270-4cf8-9055-a4fae3b98b0a": "Alberta",
    "a0988845-750c-455c-9e26-9dadd33cf136": "Alberta",

    // Method
    "5de9e305-16e5-43fa-9997-dd2d1c44515d": "Delivery",

    // Doors
    "47b72b20-b047-4c7a-8d71-8678f05a75ef": "Doors to the Cab"
  };

  function toFlat(payload) {
    const flat = {};
    const counts = {};
    const set = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      let v = idMap[val] || val;
      let k = norm(key);
      if (flat[k]) {
        counts[k] = (counts[k] || 1) + 1;
        k = `${k}_${counts[k]}`;
      } else counts[k] = 1;
      flat[k] = typeof v === "string" ? v : JSON.stringify(v);
    };

    const toLabel = (f) => {
      let v = f?.value;
      if (idMap[v]) return idMap[v];
      if (Array.isArray(v)) {
        const labels = v.map(x => idMap[x] || (x && typeof x === "object" ? (x.label || x.value) : x)).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }
      if (v && typeof v === "object") return v.label || v.value || JSON.stringify(v);
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
          const label = a.field?.label || a.label || a.id || "";
          const val = idMap[a.value] || a.email || a.phone || a.text || (a.choice && a.choice.label) || a.value || "";
          set(label, val);
        }
      }
      const hidden = d.hidden || d.meta?.hidden || {};
      for (const [k, v] of Object.entries(hidden)) set(k, idMap[v] || v);
      for (const [k, v] of Object.entries(d)) {
        if (v && typeof v !== "object") set(k, idMap[v] || v);
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

    const containerType1 = pick("container type");
    const quantity1      = toInt(pick("quantity", "quantity_1"));
    const containerType2 = pick("add a second container type to this order");
    const quantity2      = toInt(flat["quantity_2"]);
    const orderComments  = pick("comments");
    const name           = pick("name");
    const email          = pick("email");
    const phone          = cleanPhone(pick("phone number"));
    const billingAddr    = pick("billing address");
    const province       = pick("province");
    const city           = pick("city");
    const method         = pick("method");
    const deliveryAddr   = pick("delivery address/map pin/coordinates");
    const doorsDirection = pick("container doors direction for pickup");
    const siteName       = pick("site contact name");
    const sitePhone      = cleanPhone(pick("site contact phone number"));
    const deliveryNotes  = pick("delivery comments");

    const b24 = (methodName, params) => {
      const endpoint = base.endsWith("/") ? `${base}${methodName}.json` : `${base}/${methodName}.json`;
      return fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) }).then(r => r.json());
    };

    let contactId = null;
    if (email) { const byEmail = await b24("crm.contact.list", { filter: { EMAIL: email }, select: ["ID"] }); contactId = byEmail?.result?.[0]?.ID || null; }
    if (!contactId && phone) { const byPhone = await b24("crm.contact.list", { filter: { PHONE: phone }, select: ["ID"] }); contactId = byPhone?.result?.[0]?.ID || null; }
    if (!contactId && (email || phone)) {
      const contactCreate = await b24("crm.contact.add", { fields: { NAME: name || (phone ? "Caller" : "Visitor"), OPENED: "Y", EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [], PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [] } });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    const lines = [];
    lines.push("Form: invoice request");
    if (containerType1) { lines.push("", "Container type", containerType1); }
    if (quantity1)      { lines.push("", "Quantity", String(quantity1)); }
    if (containerType2) { lines.push("", "Add a second container type to this order", containerType2); }
    if (quantity2)      { lines.push("", "Quantity", String(quantity2)); }
    if (orderComments)  { lines.push("", "Comments", orderComments); }
    if (name)           { lines.push("", "Name", name); }
    if (email)          { lines.push("", "Email", email); }
    if (phone)          { lines.push("", "Phone number", phone); }
    if (billingAddr)    { lines.push("", "Billing address", billingAddr); }
    if (province)       { lines.push("", "Province", province); }
    if (city)           { lines.push("", "City", city); }
    if (method)         { lines.push("", "Method", method); }
    if (deliveryAddr)   { lines.push("", "Delivery address/Map Pin/Coordinates", deliveryAddr); }
    if (doorsDirection) { lines.push("", "Container doors direction for pickup", doorsDirection); }
    if (siteName)       { lines.push("", "Site contact name", siteName); }
    if (sitePhone)      { lines.push("", "Site contact phone number", sitePhone); }
    if (deliveryNotes)  { lines.push("", "Delivery comments", deliveryNotes); }

    const comments = lines.join("\n");

    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? `C${CATEGORY_ID}:NEW`;
    const assignedById = Number(process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.DEAL_SOURCE_ID || "WEB";

    // Generate custom title: "Invoice Request (NEW###)"
    const seq = Date.now().toString().slice(-6); // simple auto number seed
    const autoNumber = `NEW${seq}`;
    const titleBits = [`Invoice Request (${autoNumber})`];

    const dealAdd = await b24("crm.deal.add", { fields: { TITLE: titleBits.join(" "), CATEGORY_ID, STAGE_ID, ASSIGNED_BY_ID: assignedById || undefined, CONTACT_ID: contactId || undefined, SOURCE_ID: sourceId, SOURCE_DESCRIPTION: "new.storecan.ca", COMMENTS: comments } });

    if (dealAdd?.result) return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    return res.status(500).json({ error: "Failed to create deal", raw: dealAdd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
