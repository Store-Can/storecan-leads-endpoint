// /api/quote-to-deal.js — Invoice Request with rock-solid ID→Label resolution
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
    return res.status(200).json({ ok: true, method: "GET", stage: "ready" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Utilities
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "";
    try { return raw ? JSON.parse(raw) : {}; } catch {
      try { return Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; }
    }
  }
  const norm = s => (s || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const looksUUID = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const toInt = v => { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : undefined; };
  const cleanPhone = p => (p || "").replace(/[^+0-9]/g, "");

  // Optional manual map (safety net)
  let OPTION_MAP = {};
  try { if (process.env.FORM_OPTION_MAP_JSON) OPTION_MAP = JSON.parse(process.env.FORM_OPTION_MAP_JSON); } catch {}

  // In-memory cache for Tally choice dictionaries per form
  globalThis.__TALLY_CACHE__ = globalThis.__TALLY_CACHE__ || {};
  async function fetchTallyChoices(formId) {
    if (!formId) return {};
    const cache = globalThis.__TALLY_CACHE__;
    const hit = cache[formId];
    const now = Date.now();
    if (hit && now - hit.ts < 6 * 60 * 60 * 1000) return hit.map; // 6h TTL

    const key = process.env.TALLY_API_KEY || "";
    if (!key) return {}; // no API key, skip

    // Try both header styles to avoid guessing wrong
    async function tryFetch(hdr) {
      const r = await fetch(`https://api.tally.so/forms/${formId}`, { headers: hdr });
      if (r.ok) return r.json();
      // Some accounts expose fields under /forms/{id}/responses/schema
      const r2 = await fetch(`https://api.tally.so/forms/${formId}/responses/schema`, { headers: hdr }).catch(()=>null);
      if (r2 && r2.ok) return r2.json();
      return null;
    }
    const headersList = [
      { Authorization: `Bearer ${key}` },
      { "Tally-Api-Key": key }
    ];

    let json = null;
    for (const h of headersList) {
      try { json = await tryFetch(h); } catch {} // ignore
      if (json) break;
    }
    if (!json) return {}; // fail quiet, fallback to env map

    // Walk any JSON structure and collect choices {id,label}
    const map = {};
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === "object") {
        const choices = node.choices || node.options?.choices;
        if (Array.isArray(choices)) {
          for (const c of choices) {
            const id = c?.id || c?.value || c?.key;
            const label = c?.label || c?.name || c?.value;
            if (id && label) map[id] = String(label);
          }
        }
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(json);
    cache[formId] = { ts: now, map };
    return map;
  }

  // Value translator
  function idsToLabels(input, choiceMap, groupMap) {
    const arr = Array.isArray(input) ? input : [input];
    const out = [];
    for (let it of arr) {
      if (it === undefined || it === null || it === "") continue;
      if (typeof it === "object") {
        const lbl = it.label || it.name || it.text || it.value;
        if (lbl) { out.push(String(lbl)); continue; }
        it = String(it);
      }
      if (typeof it === "string") {
        if (looksUUID(it)) {
          const lbl = choiceMap[it] || groupMap[it] || "";
          out.push(lbl || it);
        } else {
          out.push(it);
        }
      }
    }
    // compact and dedupe
    return [...new Set(out.filter(Boolean))].join(", ");
  }

  // Parse Tally payload, resolve IDs using choice maps
  async function parseTally(payload) {
    const data = payload?.data || payload || {};
    const formId = data?.form_id || data?.formId || process.env.TALLY_FORM_ID || "";
    const choiceMap = await fetchTallyChoices(String(formId).trim());
    const groupMap = {
      // optional group-specific fallbacks
      ...(OPTION_MAP.container_type || {}),
      ...(OPTION_MAP.method || {}),
      ...(OPTION_MAP.pickup_location || {}),
      ...(OPTION_MAP.province || {}),
      ...(OPTION_MAP.door_orientation || {})
    };

    const flat = {};
    const put = (k, v) => { if (v !== undefined && v !== null && v !== "") flat[norm(k)] = String(v); };

    // 1) fields[] first pass, convert arrays or UUIDs to labels
    if (Array.isArray(data.fields)) {
      for (const f of data.fields) {
        const label = f?.label || f?.key || f?.id || "";
        const val = f?.value;
        if (val !== undefined) put(label, idsToLabels(val, choiceMap, groupMap));
      }
    }

    // 2) answers[] second pass, prefer any explicit text
    const answers = data.answers || data.form_response?.answers || [];
    if (Array.isArray(answers)) {
      for (const a of answers) {
        const label = a?.field?.label || a?.label || a?.field?.id || a?.id || "";
        const val =
          a?.text || a?.email || a?.phone ||
          (a?.choice && (a.choice.label || a.choice.value)) ||
          (a?.choices && (a.choices.labels?.join(", ") || a.choices.values?.join(", "))) ||
          (a?.value !== undefined ? idsToLabels(a.value, choiceMap, groupMap) : "");
        if (val) put(label, val);
      }
    }

    // 3) hidden/meta and top-level scalars
    const hidden = data.hidden || data.meta?.hidden || {};
    for (const [k, v] of Object.entries(hidden)) put(k, v);
    for (const [k, v] of Object.entries(data)) if (v && typeof v !== "object") put(k, v);

    return { flat, choiceMap };
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE;
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const raw = await readBody(req);
    const { flat, choiceMap } = await parseTally(raw);

    const pick = (...names) => {
      for (const n of names) {
        const v = flat[norm(n)];
        if (v) return v;
      }
      return "";
    };

    // Read fields
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
    const nameForContact = name || (phone ? "Caller" : "Visitor");
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

    // Comment block
    const lines = [];
    const showOr = v => v || "Selection not captured";
    lines.push("Form: invoice request");

    lines.push("", "Container type", showOr(containerType1));
    if (quantity1 !== undefined) lines.push("", "Quantity", String(quantity1));

    if (containerType2 || quantity2 !== undefined) {
      lines.push("", "Add a second container type to this order", showOr(containerType2));
      if (quantity2 !== undefined) lines.push("", "Quantity", String(quantity2));
    }

    if (containerType3 || quantity3 !== undefined) {
      lines.push("", "Add a third container type to this order", showOr(containerType3));
      if (quantity3 !== undefined) lines.push("", "Quantity", String(quantity3));
    }

    if (orderComments)  lines.push("", "Comments", orderComments);
    if (name)           lines.push("", "Name", name);
    if (email)          lines.push("", "Email", email);
    if (phone)          lines.push("", "Phone number", phone);

    if (billingAddr)    lines.push("", "Billing address", billingAddr);
    if (province)       lines.push("", "Province", province);
    if (city)           lines.push("", "City", city);

    if (methodHuman)    lines.push("", "Method", methodHuman);
    if (pickupLocation) lines.push("", "Location", pickupLocation);

    if (deliveryAddr)   lines.push("", "Delivery address/Map Pin/Coordinates", deliveryAddr);
    if (doorsDirection) lines.push("", "Container door orientation", doorsDirection);
    if (siteName)       lines.push("", "Site contact name", siteName);
    if (sitePhone)      lines.push("", "Site contact phone number", sitePhone);
    if (deliveryNotes)  lines.push("", "Delivery comments", deliveryNotes);

    if (utm_source || utm_medium || utm_campaign || utm_term || utm_content) {
      lines.push("", "UTM", `source=${utm_source || ""}, medium=${utm_medium || ""}, campaign=${utm_campaign || ""}, term=${utm_term || ""}, content=${utm_content || ""}`);
    }

    // If anything is still an unknown UUID, print a short hint so you can add it once to FORM_OPTION_MAP_JSON
    const showHints = String(process.env.DEBUG_SHOW_RAW_IDS || "").trim() === "1";
    if (showHints) {
      const hints = [];
      const maybeIDs = [
        ["container_type_1", containerType1],
        ["container_type_2", containerType2],
        ["container_type_3", containerType3],
        ["province", province],
        ["method", methodHuman],
        ["door_orientation", doorsDirection]
      ];
      for (const [k, v] of maybeIDs) if (looksUUID(v)) hints.push(`${k}: ${v}`);
      if (hints.length) lines.push("", "Mapping hints (IDs)", ...hints);
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
        CATEGORY_ID,
        STAGE_ID,
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
