// /api/quote-to-deal.js  – INVOICE REQUEST (Invoice pipeline) – UUID mapping fix
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

  // best effort form flattener, supports duplicate labels (e.g., two "Quantity")
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

    const toLabel = (f) => {
      let v = f?.value;
      if (Array.isArray(v)) {
        const labels = v.map(x => (x && typeof x === "object")
          ? (x.label || x.name || x.text || x.value || x.choice || x.email || x.phone)
          : x).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }
      if (v && typeof v === "object") {
        return v.label || v.name || v.text || v.value || v.choice || v.email || v.phone || JSON.stringify(v);
      }
      const opts = f?.options?.choices || f?.options || f?.choices || [];
      if (opts && v) {
        const asArray = Array.isArray(v) ? v : [v];
        const labels = asArray.map(id => {
          const hit = opts.find(o => o?.id === id || o?.key === id || o?.value === id || o === id);
          return hit?.label || hit?.name || hit?.value || hit || id;
        }).filter(Boolean);
        if (labels.length) return labels.join(", ");
      }
      if (f?.choices?.labels?.length) return f.choices.labels.join(", ");
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
          if (f.key) set(`${f.key}_raw`, val);
          if (f.id) set(`${f.id}_raw`, val);
        }
      }

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
          if (a.field?.id) set(`${a.field.id}_raw`, val);
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

  // small helpers and hard maps for UUID-only fields
  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");
  const toInt = v => { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : undefined; };
  const UUID_MAP = {
    container_type: {
      "e7ae7ebd-0f39-4584-96a9-5f5154bdbbfb": "40' L x 8' W x 9'6\" H HC New (1trip) Double Doors",
      "681d358d-ca15-49cc-a215-84edf5d08fb3": "40' L x 8' W x 9'6\" H HC NEW (1trip)"
    },
    province: {
      "c1d119fa-2270-4cf8-9055-a4fae3b98b0a": "Alberta"
    },
    method: {
      "5de9e305-16e5-43fa-9997-dd2d1c44515d": "Delivery"
    },
    doors_direction: {
      "47b72b20-b047-4c7a-8d71-8678f05a75ef": "Doors to the Cab"
    }
  };
  const looksLikeUUID = v => typeof v === "string" && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v);
  const resolveUUID = (group, val) => UUID_MAP[group]?.[String(val)] || val;

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

    // Map exact fields to mirror the email
    // Primary item
    let containerType1 = pick("container type", "container_type", "container size");
    containerType1 = resolveUUID("container_type", containerType1);
    const quantity1      = toInt(pick("quantity", "quantity_1", "qty", "count"));

    // Optional second item
    let containerType2 = pick("add a second container type to this order", "add_a_second_container_type_to_this_order", "container type 2", "second container type");
    containerType2 = resolveUUID("container_type", containerType2);
    const quantity2      = toInt(flat["quantity_2"]) || toInt(flat["quantity_3"]) || toInt(flat["quantity_4"]) || toInt(flat["quantity_5"]);

    const orderComments = pick("comments", "order_comments");

    const name          = pick("name", "full_name", "fullName");
    const email         = pick("email", "your_email");
    const phone         = cleanPhone(pick("phone number", "phone_number", "phone", "your_phone"));

    const billingAddr   = pick("billing address", "billing_address", "address");
    let province        = pick("province", "province_state");
    province = resolveUUID("province", province);
    const city          = pick("city", "billing_city");

    let methodRaw       = pick("method", "delivery_method");
    methodRaw = resolveUUID("method", methodRaw);
    const method        = (methodRaw || "").toLowerCase() === "delivery" ? "delivery" : (methodRaw || "").toLowerCase() === "pickup" ? "pickup" : (methodRaw || "").toLowerCase();

    const deliveryAddress = pick("delivery address/map pin/coordinates", "delivery_address", "delivery_location", "map pin", "map_pin", "coordinates");

    // Pickup specific
    let doorsPickupRaw = pick("container doors direction for pickup", "doors_direction_for_pickup", "doors_direction_pickup", "doors_direction");
    doorsPickupRaw = resolveUUID("doors_direction", doorsPickupRaw);
    const doorsDirection = (() => {
      const v = (doorsPickupRaw || "").toString().toLowerCase();
      if (!v) return "";
      if (["cab", "to_cab", "doors_to_cab", "front", "doors to the cab"].includes(v)) return "Doors to the Cab";
      if (["back", "to_back", "doors_to_back", "rear", "doors to the back"].includes(v)) return "Doors to the Back";
      return doorsPickupRaw;
    })();

    // Delivery specific
    const siteName      = pick("site contact name", "site_name", "sitecontactname");
    const sitePhone     = cleanPhone(pick("site contact phone number", "site_phone", "sitecontactphone"));
    const deliveryNotes = pick("delivery comments", "delivery_comments", "delivery_notes");

    const utm_source    = pick("utm_source");
    const utm_medium    = pick("utm_medium");
    const utm_campaign  = pick("utm_campaign");
    const utm_term      = pick("utm_term");
    const utm_content   = pick("utm_content");

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
    const searchEmail = email?.trim();
    const searchPhone = phone?.trim();

    if (searchEmail) {
      const byEmail = await b24("crm.contact.list", { filter: { EMAIL: searchEmail }, select: ["ID"] });
      contactId = byEmail?.result?.[0]?.ID || null;
    }
    if (!contactId && searchPhone) {
      const byPhone = await b24("crm.contact.list", { filter: { PHONE: searchPhone }, select: ["ID"] });
      contactId = byPhone?.result?.[0]?.ID || null;
    }
    if (!contactId && (searchEmail || searchPhone)) {
      const contactCreate = await b24("crm.contact.add", {
        fields: {
          NAME: name || (searchPhone ? "Caller" : "Visitor"),
          OPENED: "Y",
          EMAIL: searchEmail ? [{ VALUE: searchEmail, VALUE_TYPE: "WORK" }] : [],
          PHONE: searchPhone ? [{ VALUE: searchPhone, VALUE_TYPE: "WORK" }] : []
        }
      });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) Compose comments block to mirror the email layout
    const lines = [];
    lines.push("Form: invoice request");

    if (containerType1) { lines.push(""); lines.push("Container type"); lines.push(containerType1); }
    if (quantity1)      { lines.push(""); lines.push("Quantity"); lines.push(String(quantity1)); }

    if (containerType2) { lines.push(""); lines.push("Add a second container type to this order"); lines.push(containerType2); }
    if (quantity2)      { lines.push(""); lines.push("Quantity"); lines.push(String(quantity2)); }

    if (orderComments)  { lines.push(""); lines.push("Comments"); lines.push(orderComments); }

    if (name)           { lines.push(""); lines.push("Name"); lines.push(name); }
    if (email)          { lines.push(""); lines.push("Email"); lines.push(email); }
    if (phone)          { lines.push(""); lines.push("Phone number"); lines.push(phone); }

    if (billingAddr)    { lines.push(""); lines.push("Billing address"); lines.push(billingAddr); }
    if (province)       { lines.push(""); lines.push("Province"); lines.push(province); }
    if (city)           { lines.push(""); lines.push("City"); lines.push(city); }

    if (methodRaw)      { lines.push(""); lines.push("Method"); lines.push(method.charAt(0).toUpperCase() + method.slice(1)); }

    if (deliveryAddress){ lines.push(""); lines.push("Delivery address/Map Pin/Coordinates"); lines.push(deliveryAddress); }

    if (doorsDirection) { lines.push(""); lines.push("Container doors direction for pickup"); lines.push(doorsDirection); }

    if (siteName)       { lines.push(""); lines.push("Site contact name"); lines.push(siteName); }
    if (sitePhone)      { lines.push(""); lines.push("Site contact phone number"); lines.push(sitePhone); }

    if (deliveryNotes)  { lines.push(""); lines.push("Delivery comments"); lines.push(deliveryNotes); }

    if (utm_source || utm_medium || utm_campaign || utm_term || utm_content) {
      lines.push("");
      lines.push("UTM");
      lines.push(`source=${utm_source || ""}, medium=${utm_medium || ""}, campaign=${utm_campaign || ""}, term=${utm_term || ""}, content=${utm_content || ""}`);
    }

    const comments = lines.join("\n");

    // 3) Create deal in Invoice pipeline
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? process.env.QUOTE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? process.env.QUOTE_STAGE_ID ?? (CATEGORY_ID === 0 ? "NEW" : `C${CATEGORY_ID}:NEW`);
    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || process.env.DEAL_SOURCE_ID || "WEB";

    const titleBits = [
      containerType1 || "Invoice request",
      quantity1 ? `x${quantity1}` : null,
      city || province || null
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
