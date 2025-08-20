// /api/quote-to-deal.js
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

  if (req.method !== "POST" && req.method !== "GET") {
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

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, method: "GET", stage: "stub-get" });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, method: 'GET', stage: 'stub-get' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const base = process.env.B24_WEBHOOK_BASE; // https://.../rest/USER/TOKEN
    if (!base) return res.status(500).json({ error: 'Missing B24_WEBHOOK_BASE' });

    const {
      name = '',
      email = '',
      phone = '',
      message = '',
      city = '',
      province = '',
      container_size = '',
      condition = '',
      page_url = '',
      utm_source, utm_medium, utm_campaign, utm_term, utm_content
    } = req.body || {};

    // helper
    const b24 = (method, params) =>
      fetch(`${base}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {})
      }).then(r => r.json());

    // 1) find or create contact (only if we have email or phone)
    let contactId = null;

    const tryFind = async () => {
      if (email) {
        const byEmail = await b24('crm.contact.list', { filter: { 'EMAIL': email }, select: ['ID'] });
        if (byEmail?.result?.[0]?.ID) return byEmail.result[0].ID;
      }
      if (phone) {
        const byPhone = await b24('crm.contact.list', { filter: { 'PHONE': phone }, select: ['ID'] });
        if (byPhone?.result?.[0]?.ID) return byPhone.result[0].ID;
      }
      return null;
    };

    contactId = await tryFind();

    if (!contactId && (email || phone)) {
      const contactCreate = await b24('crm.contact.add', {
        fields: {
          NAME: name || (phone ? 'Caller' : 'Visitor'),
          OPENED: 'Y',
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: 'WORK' }] : undefined,
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: 'WORK' }] : undefined
        }
      });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) build comments
    const comments = [
      `Form: quote / call request`,
      message && `Message: ${message}`,
      container_size && `Container: ${container_size}`,
      condition && `Condition: ${condition}`,
      city && province && `Location: ${city}, ${province}`,
      email && `Email: ${email}`,
      phone && `Phone: ${phone}`,
      page_url && `Page: ${page_url}`,
      (utm_source || utm_medium || utm_campaign || utm_term || utm_content) &&
        `UTM: source=${utm_source || ''}, medium=${utm_medium || ''}, campaign=${utm_campaign || ''}, term=${utm_term || ''}, content=${utm_content || ''}`
    ].filter(Boolean).join('\n');

    // 3) create deal in Category 0, Stage C0:NEW
    const CATEGORY_ID = 0;         // the board you showed
    const STAGE_ID = 'C0:NEW';     // first column

    const titleBits = [name || phone || 'Quote request', container_size || '', city || province || '']
      .filter(Boolean)
      .join(' | ');

    const dealAdd = await b24('crm.deal.add', {
      fields: {
        TITLE: `Quote Request: ${titleBits}`.slice(0, 250),
        CATEGORY_ID,
        STAGE_ID,
        CONTACT_ID: contactId || undefined,
        COMMENTS: comments
      }
    });

    if (dealAdd?.result) {
      return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    }
    return res.status(500).json({ error: 'Failed to create deal', raw: dealAdd });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
