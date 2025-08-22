// /api/quote-to-deal.js – INVOICE REQUEST with robust array/ID → label handling
export default async function handler(req, res) {
  // CORS
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
    return res.status(200).json({ ok: true, method: "GET" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Body reader
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "";
    try { return raw ? JSON.parse(raw) : {}; } catch {
      try { return Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; }
    }
  }

  // utils
  const norm = s => (s || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const looksLikeUUID = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");
  const toInt = v => {
    const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : undefined;
  };

  // optional env map
  let OPTION_MAP = {};
  try {
    if (process.env.FORM_OPTION_MAP_JSON) OPTION_MAP = JSON.parse(process.env.FORM_OPTION_MAP_JSON);
  } catch { OPTION_MAP = {}; }
  const mapByGroup = (group, id) => {
    if (!id) return "";
    const g = OPTION_MAP[group] || {};
    return g[id] || "";
  };
  const mapAny = id => {
    for (const g of Object.values(OPTION_MAP || {})) {
      if (g && typeof g === "object" && g[id]) return g[id];
    }
    return "";
  };

  // Convert raw value(s) to human label(s)
  function idsToLabels(ids, choices, groupHint) {
    const arr = Array.isArray(ids) ? ids : [ids];
    const labels = [];
    for (const it of arr) {
      if (it && typeof it === "object") {
        const lbl = it.label || it.name || it.text || it.value;
        if (lbl) { labels.push(String(lbl)); continue; }
      }
      if (typeof it === "string") {
        // try choices from the field first
        const hit = (choices || []).find(c => c?.id === it || c?.key === it || c?.value === it);
        if (hit?.label) { labels.push(String(hit.label)); continue; }
        // try env map
        const m = (groupHint && mapByGroup(groupHint, it)) || mapAny(it);
        if (m) { labels.push(String(m)); continue; }
        // otherwise keep raw string
        labels.push(it);
      }
    }
    // dedupe and join
    return [...new Set(labels.filter(Boolean))].join(", ");
  }

  // flatten Tally payload, prefer labels, handle arrays
  function toFlat(payload) {
    const flat = {};
    const counts = {};
    const put = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      let k = norm(key);
      if (flat[k]) {
        counts[k] = (counts[k] || 1) + 1;
        k = `${k}_${counts[k]}`;
      } else counts[k] = 1;
      flat[k] = String(val); // always plain string
    };
    const replace = (key, val) => { if (val !== undefined && val !== null && val !== "") flat[norm(key)] = String(val); };

    const d = payload?.data || payload;

    // 1) fields[]: may contain raw IDs, sometimes with options.choices
    if (Array.isArray(d?.fields)) {
      for (const f of d.fields) {
        const label = f?.label || f?.key || f?.id || "";
        const lnorm = norm(label);
        let groupHint = "";
        if (lnorm.includes("container_type")) groupHint = "container_type";
        else if (lnorm.includes("method")) groupHint = "method";
        else if (lnorm.includes("location")) groupHint = "pickup_location";
        else if (lnorm.includes("province")) groupHint = "province";
        else if (lnorm.includes("door")) groupHint = "door_orientation";

        const choices = f?.options?.choices || f?.choices || [];

        if (f?.value !== undefined) {
          const val = idsToLabels(f.value, choices, groupHint);
          put(label, val);
        }
      }
    }

    // 2) answers[]: usually carries human label(s). Overwrite previous values.
    const answers = d?.answers || d?.form_response?.answers || [];
    if (Array.isArray(answers)) {
      for (const a of answers) {
        const label = a?.field?.label || a?.label || a?.field?.id || a?.id || "";
        const lnorm = norm(label);
        let groupHint = "";
        if (lnorm.includes("container_type")) groupHint = "container_type";
        else if (lnorm.includes("method")) groupHint = "method";
        else if (lnorm.includes("location")) groupHint = "pickup_location";
        else if (lnorm.includes("province")) groupHint = "province";
        else if (lnorm.includes("door")) groupHint = "door_orientation";

        const choices = a?.field?.choices || a?.choices?.choices || [];
        // Build a best-value from all possible shapes
        const val =
          a?.text || a?.email || a?.phone ||
          (a?.choice && (a.choice.label || a.choice.value)) ||
          (a?.choices && (a.choices.labels?.join(", ") || a.choices.values?.join(", "))) ||
          (a?.value !== undefined ? idsToLabels(a.value, choices, groupHint) : "");

        if (val) replace(label, val);
      }
    }

    // 3) hidden/meta
    const hidden = d?.hidden || d?.meta?.hidden || {};
    for (const [k, v] of Object.entries(hidden)) put(k, v);

    // 4) top-level primitives
    for (const [k, v] of Object.entries(d || {})) {
      if (v && typeof v !== "object") put(k, v);
    }

    return flat;
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE;
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);
    const flat = toFlat(raw);

    // prefer explicit hidden label overrides if you later add them in Tally
    const labelOverrides = {
      container_type: raw?.container_type_label,
      container_type_2: raw?.container_type_2_label,
      container_type_3: raw?.container_type_3_label,
      method: raw?.method_label,
      pickup_location: raw?.pickup_location_label,
      province: raw?.province_label
    };

    const pick = (...cands) => {
      for (const c of cands) {
        const n = norm(c);
        if (/container_type_3/.test(n) && labelOverrides.container_type_3) return labelOverrides.container_type_3;
        if (/container_type_2/.test(n) && labelOverrides.container_type_2) return labelOverrides.container_type_2;
        if (/container_type$/.test(n)   && labelOverrides.container_type)   return labelOverrides.container_type;
        if (/method/.test(n)            && labelOverrides.method)           return labelOverrides.method;
        if (/pickup|location/.test(n)   && labelOverrides.pickup_location)  return labelOverrides.pickup_location;
        if (/province/.test(n)          && labelOverrides.province)         return labelOverrides.province;

        const v = flat[n];
        if (v) return v;
      }
      return "";
    };

    // fields for comments
    const containerType1 = pick("Container type", "container_type");
    const quantity1      = toInt(pick("Quantity", "quantity_1"));

    const containerType2 = pick("Add a second container type to this order", "container_type_2");
    const quantity2      = toInt(pick("quantity_2", "Quantity_2"));

    const containerType3 = pick("Add a third container type to this order", "container_type_3");
    const quantity3      = toInt(pick("quantity_3", "Quantity_3"));

    const orderComments  = pick("Comments", "comments", "order_comments");

    const name           = pick("Name", "full_name");
    const email          = pick("Email", "your_email");
    const phone          = cleanPhone(pick("Phone number", "phone", "phone_number"));

    const billingAddr    = pick("Billing address", "billing_address", "address");
    const province       = pick("Province", "province");
    const city           = pick("City", "city");

    const methodHuman    = pick("Method", "method");
    const pickupLocation = pick("Location", "pickup_location");

    const deliveryAddr   = pick("Delivery address/Map Pin/Coordinates", "delivery_address");
    const doorsDirection = pick("Container door orientation", "Container doors direction for pickup", "doors_direction");

    const siteName       = pick("Site contact name", "site_name");
    const sitePhone      = cleanPhone(pick("Site contact phone number", "site_phone"));
    const deliveryNotes  = pick("Delivery comments", "delivery_comments", "delivery_notes");

    const utm_source     = pick("utm_source");
    const utm_medium     = pick("utm_medium");
    const utm_campaign   = pick("utm_campaign");
    const utm_term       = pick("utm_term");
    const utm_content    = pick("utm_content");

    const nameForContact = name || (phone ? "Caller" : "Visitor");

    // Bitrix helper
    const b24 = (methodName, params) => {
      const endpoint = base.endsWith("/") ? `${base}${methodName}.json` : `${base}/${methodName}.json`;
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params || {})
      }).then(r => r.json());
    };

    // Contact
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
      const add = await b24("crm.contact.add", {
        fields: {
          NAME: nameForContact,
          OPENED: "Y",
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : []
        }
      });
      if (add?.result) contactId = add.result;
    }

    // Comments
    const lines = [];
    const showOr = v => v || "Selection not captured";
    lines.push("Form: invoice request");

    lines.push("", "Container type", showOr(containerType1));
    if (quantity1 !== undefined) { lines.push("", "Quantity", String(quantity1)); }

    if (containerType2 || quantity2 !== undefined) {
      lines.push("", "Add a second container type to this order", showOr(containerType2));
      if (quantity2 !== undefined) lines.push("", "Quantity", String(quantity2));
    }

    if (containerType3 || quantity3 !== undefined) {
      lines.push("", "Add a third container type to this order", showOr(containerType3));
      if (quantity3 !== undefined) lines.push("", "Quantity", String(quantity3));
    }

    if (orderComments)  { lines.push("", "Comments", orderComments); }
    if (name)           { lines.push("", "Name", name); }
    if (email)          { lines.push("", "Email", email); }
    if (phone)          { lines.push("", "Phone number", phone); }
    if (billingAddr)    { lines.push("", "Billing address", billingAddr); }
    if (province)       { lines.push("", "Province", province); }
    if (city)           { lines.push("", "City", city); }

    if (methodHuman)    { lines.push("", "Method", methodHuman); }
    if (pickupLocation) { lines.push("", "Location", pickupLocation); }

    if (deliveryAddr)   { lines.push("", "Delivery address/Map Pin/Coordinates", deliveryAddr); }
    if (doorsDirection) { lines.push("", "Container door orientation", doorsDirection); }
    if (siteName)       { lines.push("", "Site contact name", siteName); }
    if (sitePhone)      { lines.push("", "Site contact phone number", sitePhone); }
    if (deliveryNotes)  { lines.push("", "Delivery comments", deliveryNotes); }

    if (utm_source || utm_medium || utm_campaign || utm_term || utm_content) {
      lines.push("", "UTM", `source=${utm_source || ""}, medium=${utm_medium || ""}, campaign=${utm_campaign || ""}, term=${utm_term || ""}, content=${utm_content || ""}`);
    }

    const comments = lines.join("\n");

    // Deal
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? process.env.QUOTE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? process.env.QUOTE_STAGE_ID ?? (CATEGORY_ID === 0 ? "NEW" : `C${CATEGORY_ID}:NEW`);
    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || process.env.DEAL_SOURCE_ID || "WEB";
    const newCode = `NEW${Math.floor(Date.now() / 1000)}`;

    const title = [`Invoice Request (${newCode})`, city || province].filter(Boolean).join(" | ").slice(0, 250);

    const addDeal = await b24("crm.deal.add", {
      fields: {
        TITLE: title,
        CATEGORY_ID: CATEGORY_ID,
        STAGE_ID: STAGE_ID,
        ASSIGNED_BY_ID: assignedById || undefined,
        CONTACT_ID: contactId || undefined,
        SOURCE_ID: sourceId,
        SOURCE_DESCRIPTION: "new.storecan.ca",
        COMMENTS: comments
      }
    });

    if (addDeal?.result) return res.status(200).json({ ok: true, deal_id: addDeal.result });
    return res.status(500).json({ error: "Failed to create deal", raw: addDeal });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
