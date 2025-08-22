// /api/quote-to-deal.js  – INVOICE REQUEST (Invoice pipeline) with robust label-first parsing
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
    return res.status(200).json({ ok: true, method: "GET", stage: "ready" });
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

  // utils
  const norm = s => (s || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const looksLikeUUID = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");
  const toInt = v => {
    const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : undefined;
  };

  // load optional id→label map from env
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

  // flattener that prefers human labels over IDs and supports duplicate field labels
  function toFlat(payload) {
    const flat = {};
    const counts = {};
    const rawIds = {}; // for diagnostics

    const put = (key, val, groupHint) => {
      if (val === undefined || val === null || val === "") return;

      // try to translate IDs
      let v = val;
      if (looksLikeUUID(v)) {
        v = mapByGroup(groupHint, val) || mapAny(val) || val;
        // keep raw in case we still did not translate
        rawIds[norm(key)] = rawIds[norm(key)] || [];
        rawIds[norm(key)].push(val);
      }

      let k = norm(key);
      if (flat[k]) {
        counts[k] = (counts[k] || 1) + 1;
        k = `${k}_${counts[k]}`;
      } else {
        counts[k] = 1;
      }
      flat[k] = typeof v === "string" ? v : JSON.stringify(v);
    };

    // prefer logic: if the same normalized key appears twice, and the new value is more human than the old, replace
    const replaceIfBetter = (key, val, groupHint) => {
      if (val === undefined || val === null || val === "") return;
      const k = norm(key);
      const existing = flat[k];

      let v = val;
      if (looksLikeUUID(v)) v = mapByGroup(groupHint, val) || mapAny(val) || val;

      // new is better if existing is a UUID or "Selection not captured" and new is not a UUID
      const newIsBetter =
        existing &&
        ((looksLikeUUID(existing) && !looksLikeUUID(v)) ||
         (/selection not captured/i.test(existing) && v));
      if (newIsBetter) flat[k] = v;
    };

    const d = payload?.data || payload;

    // 1) Tally v2: data.fields[] often holds raw IDs. Capture them, but allow later overwrite.
    if (Array.isArray(d?.fields)) {
      for (const f of d.fields) {
        const label = f?.label || f?.key || f?.id || "";
        let groupHint = "";
        const lnorm = norm(label);
        if (lnorm.includes("container_type")) groupHint = "container_type";
        else if (lnorm.includes("method")) groupHint = "method";
        else if (lnorm.includes("location")) groupHint = "pickup_location";
        else if (lnorm.includes("province")) groupHint = "province";

        const val = f?.value;
        if (val !== undefined && val !== null && val !== "") {
          put(label, val, groupHint);
          if (f?.key) put(`${f.key}_raw`, val, groupHint);
          if (f?.id) put(`${f.id}_raw`, val, groupHint);
        }

        // if the field exposes options.choices, translate immediately
        const choices = f?.options?.choices || f?.choices || [];
        if (choices && choices.length && looksLikeUUID(val)) {
          const match = choices.find(c =>
            c?.id === val || c?.value === val || c?.key === val
          );
          if (match?.label) replaceIfBetter(label, match.label, groupHint);
        }
      }
    }

    // 2) answers[] carries human labels. Let them overwrite IDs from step 1.
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

        const val =
          a?.text ||
          a?.email ||
          a?.phone ||
          (a?.choice && (a.choice.label || a.choice.value)) ||
          (a?.choices && (a.choices.labels?.join(", ") || a.choices.values?.join(", "))) ||
          a?.value ||
          a?.answer ||
          "";

        if (val !== "") replaceIfBetter(label, val, groupHint);
      }
    }

    // 3) hidden/meta
    const hidden = d?.hidden || d?.meta?.hidden || {};
    for (const [k, v] of Object.entries(hidden)) put(k, v);

    // 4) top-level primitives
    for (const [k, v] of Object.entries(d || {})) {
      if (v && typeof v !== "object") put(k, v);
    }

    return { flat, rawIds };
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE;
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);

    // Allow label overrides from explicitly named hidden fields if you decide to add them in Tally later
    const labelOverrides = {
      container_type: raw?.container_type_label,
      container_type_2: raw?.container_type_2_label,
      container_type_3: raw?.container_type_3_label,
      method: raw?.method_label,
      pickup_location: raw?.pickup_location_label,
      province: raw?.province_label
    };

    const { flat, rawIds } = toFlat(raw);

    // helper to pick the first available value among candidates
    const pick = (...cands) => {
      for (const c of cands) {
        const n = norm(c);
        // prefer explicit label override
        if (/container_type_3/.test(n) && labelOverrides.container_type_3) return labelOverrides.container_type_3;
        if (/container_type_2/.test(n) && labelOverrides.container_type_2) return labelOverrides.container_type_2;
        if (/container_type/.test(n) && labelOverrides.container_type) return labelOverrides.container_type;
        if (/method/.test(n) && labelOverrides.method) return labelOverrides.method;
        if (/pickup/.test(n) && labelOverrides.pickup_location) return labelOverrides.pickup_location;
        if (/province/.test(n) && labelOverrides.province) return labelOverrides.province;

        const v = flat[n];
        if (v) return v;
      }
      return "";
    };

    // Core fields mirroring your email layout
    const containerType1 = pick("Container type", "container_type");
    const quantity1      = toInt(pick("Quantity", "quantity_1"));

    const containerType2 = pick("Add a second container type to this order", "container_type_2");
    const quantity2      = toInt(pick("quantity_2", "Quantity_2"));

    const containerType3 = pick("Add a third container type to this order", "container_type_3");
    const quantity3      = toInt(pick("quantity_3", "Quantity_3"));

    const orderComments  = pick("Comments", "comments", "order_comments");

    const name           = pick("Name", "full_name", "Full name");
    const email          = pick("Email", "your_email");
    const phone          = cleanPhone(pick("Phone number", "phone", "phone_number"));

    const billingAddr    = pick("Billing address", "billing_address", "address");
    const province       = pick("Province", "province");
    const city           = pick("City", "city");

    const methodHuman    = pick("Method", "method");
    const deliveryAddr   = pick("Delivery address/Map Pin/Coordinates", "delivery_address");
    const doorsDirection = pick("Container door orientation", "Container doors direction for pickup", "doors_direction");

    const siteName       = pick("Site contact name", "site_name");
    const sitePhone      = cleanPhone(pick("Site contact phone number", "site_phone"));
    const deliveryNotes  = pick("Delivery comments", "delivery_comments", "delivery_notes");

    const pickupLocation = pick("Location", "pickup_location");

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
          NAME: nameForContact,
          OPENED: "Y",
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : []
        }
      });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) Build Bitrix comments, mirroring your email
    const lines = [];
    lines.push("Form: invoice request");

    const showOrPlaceholder = v => v || "Selection not captured";

    lines.push("", "Container type", showOrPlaceholder(containerType1));
    if (quantity1 !== undefined) { lines.push("", "Quantity", String(quantity1)); }

    if (containerType2 || quantity2 !== undefined) {
      lines.push("", "Add a second container type to this order", showOrPlaceholder(containerType2));
      if (quantity2 !== undefined) { lines.push("", "Quantity", String(quantity2)); }
    }

    if (containerType3 || quantity3 !== undefined) {
      lines.push("", "Add a third container type to this order", showOrPlaceholder(containerType3));
      if (quantity3 !== undefined) { lines.push("", "Quantity", String(quantity3)); }
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

    // Helpful hints when IDs slip through
    const showHints = String(process.env.DEBUG_SHOW_RAW_IDS || "").trim() === "1";
    if (showHints) {
      const hintLines = [];
      if (looksLikeUUID(containerType1)) hintLines.push(`container_type_1: ${containerType1}`);
      if (looksLikeUUID(containerType2)) hintLines.push(`container_type_2: ${containerType2}`);
      if (looksLikeUUID(containerType3)) hintLines.push(`container_type_3: ${containerType3}`);
      if (looksLikeUUID(methodHuman))    hintLines.push(`method: ${methodHuman}`);
      if (looksLikeUUID(pickupLocation)) hintLines.push(`pickup_location: ${pickupLocation}`);
      if (hintLines.length) {
        lines.push("", "Mapping hints (IDs)", ...hintLines);
      }
    }

    const comments = lines.join("\n");

    // 3) Create deal in Invoice pipeline
    const CATEGORY_ID = Number(process.env.INVOICE_CATEGORY_ID ?? process.env.QUOTE_CATEGORY_ID ?? 6);
    const STAGE_ID = process.env.INVOICE_STAGE_ID ?? process.env.QUOTE_STAGE_ID ?? (CATEGORY_ID === 0 ? "NEW" : `C${CATEGORY_ID}:NEW`);
    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || process.env.DEAL_SOURCE_ID || "WEB";

    // Title: Invoice Request (NEW + short timecode)
    const newCode = `NEW${Math.floor(Date.now() / 1000)}`;
    const titleBits = [
      `Invoice Request (${newCode})`,
      city || province || ""
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
