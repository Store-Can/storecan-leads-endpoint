// api/request-to-deal.js
// Creates a Bitrix Deal in your "Invoice request" pipeline and
// writes all Tally answers into COMMENTS. Safe and resilient.

function readJSON(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return { raw: String(body) }; }
}

function getHeaderOrigin(req) {
  return req.headers?.origin || req.headers?.Origin || "";
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

// Turn a Tally field into "Label: Value"
function valueToText(field) {
  const v = field?.value;
  if (v == null) return "";

  // Dropdowns / Radios: map option id -> option text
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

  // Objects with text/email/phone properties
  if (typeof v === "object") {
    const { text, email, phone, value } = v;
    return text || email || phone || value || JSON.stringify(v);
  }

  // Everything else
  return String(v);
}

// Build a nice multi-line comment from Tally’s payload
function buildComments(payload) {
  const parts = [];

  // Tally webhook wrapper
  const d = payload?.data || payload;

  const fields = Array.isArray(d?.fields) ? d.fields : [];
  if (fields.length) {
    for (const f of fields) {
      const label = f?.label || f?.title || f?.key || "Field";
      const text = valueToText(f);
      if (text) parts.push(`${label}: ${text}`);
    }
  } else {
    // Fallback: dump payload if structure is unexpected
    parts.push("Raw payload:");
    parts.push("```");
    parts.push(JSON.stringify(payload, null, 2));
    parts.push("```");
  }

  // Meta info
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

export default async function handler(req, res) {
  // CORS, incl. preflight
  if (setCORS(req, res)) return;
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, method: "GET", stage: "live" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = readJSON(req.body);

    const base  = process.env.B24_WEBHOOK_BASE;  // e.g. https://b24-xxx.bitrix24.com/rest/10/abcdefg/
    const catId = process.env.DEAL_CATEGORY_ID ? Number(process.env.DEAL_CATEGORY_ID) : undefined; // e.g. 6
    const stage = process.env.DEAL_STAGE_ID;    // e.g. C6:NEW

    if (!base || !stage) {
      return res.status(500).json({ error: "MISSING_ENV", hasBase: !!base, hasStage: !!stage });
    }

    const comments = buildComments(body);

    const payload = {
      fields: {
        TITLE: "Invoice Request",
        CATEGORY_ID: catId,
        STAGE_ID: stage,
        SOURCE_ID: "WEB",
        COMMENTS: comments
      },
      params: { REGISTER_SONET_EVENT: "Y" }
    };

    const r = await fetch(`${base}crm.deal.add.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { status: r.status, raw: text }; }

    if (j && j.error) {
      return res.status(502).json({ error: j.error, description: j.error_description || "", raw: j });
    }

    return res.status(200).json({ ok: true, dealId: j.result || null });
  } catch (e) {
    return res.status(500).json({ error: "CRASH", message: String(e?.message || e) });
  }
}
