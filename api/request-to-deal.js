// api/request-to-deal.js
// Creates a Bitrix Deal in the "Invoice request" pipeline and links a Contact.
// It will:
// 1) Try to find an existing contact by EMAIL, then PHONE
// 2) Create a contact if none is found (when email or phone present)
// 3) Create the Deal with CONTACT_ID attached
// 4) Always create a Deal even if contact info is missing

function readJSON(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return { raw: String(body) }; }
}

function setCORS(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// Turn a Tally field "value" into plain text for comments or parsing
function valueToText(field) {
  const v = field?.value;
  if (v == null) return "";

  // Map option id(s) to their text
  if (field?.options && Array.isArray(field.options)) {
    if (Array.isArray(v)) {
      const text = v
        .map(id => field.options.find(o => o.id === id)?.text || id)
        .join(", ");
      return text;
    }
    const match = field.options.find(o => o.id === v);
    if (match?.text) return match.text;
  }

  if (typeof v === "object") {
    const { text, email, phone, value } = v;
    return text || email || phone || value || JSON.stringify(v);
  }

  return String(v);
}

// Pull a value from Tally payload by matching label text
function findValue(payload, labelHints) {
  const fields = Array.isArray(payload?.data?.fields) ? payload.data.fields : [];
  const lowerHints = labelHints.map(h => h.toLowerCase());
  for (const f of fields) {
    const label = (f?.label || f?.title || f?.key || "").toLowerCase();
    if (lowerHints.some(h => label.includes(h))) {
      const txt = valueToText(f);
      if (txt) return txt;
    }
  }
  return null;
}

// Build Deal comment from all fields so we never lose data
function buildComments(payload) {
  const parts = [];
  const d = payload?.data || payload;
  const fields = Array.isArray(d?.fields) ? d.fields : [];
  if (fields.length) {
    for (const f of fields) {
      const label = f?.label || f?.title || f?.key || "Field";
      const text = valueToText(f);
      if (text) parts.push(`${label}: ${text}`);
    }
  } else {
    parts.push("Raw payload:");
    parts.push("```");
    parts.push(JSON.stringify(payload, null, 2));
    parts.push("```");
  }

  const page = d?.pageUrl || d?.page_url || payload?.page_url;
  if (page) parts.push(`Page URL: ${page}`);

  const utmKeys = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"];
  const utms = utmKeys
    .map(k => {
      const v = d?.[k] ?? payload?.[k];
      return v ? `${k}: ${v}` : null;
    })
    .filter(Boolean);
  if (utms.length) parts.push(utms.join(" | "));

  parts.push(`Created at: ${new Date().toISOString()}`);
  return parts.join("\n");
}

// Split "Full Name" into NAME and LAST_NAME
function splitName(fullName) {
  if (!fullName) return { NAME: "Customer", LAST_NAME: "" };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { NAME: parts[0], LAST_NAME: "" };
  return { NAME: parts[0], LAST_NAME: parts.slice(1).join(" ") };
}

async function b24(base, method, payload) {
  const r = await fetch(`${base}${method}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { status: r.status, raw: text }; }
}

// Find contact by email or phone using duplicate finder
async function findContactId(base, email, phone) {
  if (email) {
    const dup = await b24(base, "crm.duplicate.findbycomm", {
      entity_type: "CONTACT",
      type: "EMAIL",
      values: [email]
    });
    const id = dup?.result?.CONTACT?.[0];
    if (id) return id;
  }

  if (phone) {
    const dup = await b24(base, "crm.duplicate.findbycomm", {
      entity_type: "CONTACT",
      type: "PHONE",
      values: [phone]
    });
    const id = dup?.result?.CONTACT?.[0];
    if (id) return id;
  }

  return null;
}

async function addContact(base, name, email, phone) {
  const { NAME, LAST_NAME } = splitName(name);
  const fields = {
    NAME,
    LAST_NAME,
    OPENED: "Y",
    TYPE_ID: "CLIENT",
    SOURCE_ID: "WEB"
  };
  if (email) fields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: "WORK" }];

  const r = await b24(base, "crm.contact.add", { fields });
  if (r?.error) throw new Error(`Add contact failed: ${r.error_description || r.error}`);
  return r?.result || null;
}

export default async function handler(req, res) {
  if (setCORS(req, res)) return;
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, method: "GET", stage: "live-with-contact" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = readJSON(req.body);

    const base  = process.env.B24_WEBHOOK_BASE;   // must end with /
    const catId = process.env.DEAL_CATEGORY_ID ? Number(process.env.DEAL_CATEGORY_ID) : undefined; // e.g. 6
    const stage = process.env.DEAL_STAGE_ID;       // e.g. C6:NEW
    if (!base || !stage) {
      return res.status(500).json({ error: "MISSING_ENV", hasBase: !!base, hasStage: !!stage });
    }

    // Pull contact info from the form (handles various labels)
    const fullName = findValue(body, [
      "billing name", "name", "contact name", "site contact name"
    ]) || "Customer";

    const email = findValue(body, [
      "email", "billing email", "contact email"
    ]);

    const phone = findValue(body, [
      "phone", "phone number", "contact phone", "site contact phone", "billing phone"
    ]);

    // Build COMMENTS for the Deal
    const comments = buildComments(body);

    // Find or create contact when possible
    let contactId = null;
    if (email || phone) {
      contactId = await findContactId(base, email, phone);
      if (!contactId) {
        try {
          contactId = await addContact(base, fullName, email, phone);
        } catch (e) {
          // Do not block deal creation if contact creation fails
          contactId = null;
        }
      }
    }

    // Create Deal with optional CONTACT_ID
    const dealFields = {
      TITLE: "Invoice Request",
      CATEGORY_ID: catId,
      STAGE_ID: stage,
      SOURCE_ID: "WEB",
      COMMENTS: comments
    };
    if (contactId) dealFields.CONTACT_ID = contactId;

    const createDeal = await b24(base, "crm.deal.add", {
      fields: dealFields,
      params: { REGISTER_SONET_EVENT: "Y" }
    });

    if (createDeal?.error) {
      return res.status(502).json({ error: createDeal.error, description: createDeal.error_description || "" });
    }

    return res.status(200).json({ ok: true, dealId: createDeal?.result || null, contactId: contactId || null });
  } catch (e) {
    return res.status(500).json({ error: "CRASH", message: String(e?.message || e) });
  }
}
