// /api/request-to-deal.js
export default async function handler(req, res) {
 const originHeader = req.headers.origin || "";
const allowedList = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
  .split(",").map(s => s.trim()).filter(Boolean);
const allowOrigin =
  allowedList.includes("*") ? "*" :
  allowedList.includes(originHeader) ? originHeader :
  allowedList[0] || "*";


  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Read body as JSON or x-www-form-urlencoded (Framer supports both)
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8") || "";
    try { return raw ? JSON.parse(raw) : {}; } catch (_) {
      try { return Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; }
    }
  }

  try {
    const b = await readBody(req);

    const hook = process.env.BITRIX_WEBHOOK_REQUESTS;
    if (!hook) return res.status(500).json({ error: "Missing BITRIX_WEBHOOK_REQUESTS" });

    const categoryId = Number(process.env.REQUEST_CATEGORY_ID ?? 0);
    let stageId = process.env.REQUEST_STAGE_ID || "";
    if (!stageId) stageId = categoryId === 0 ? "NEW" : `C${categoryId}:NEW`;

    const assignedById = Number(process.env.ASSIGNED_BY_ID || 0);
    const sourceId = process.env.DEAL_SOURCE_ID || "WEB";

    const get = k => (b?.[k] ?? "").toString();

    const first = get("firstName");
    const last = get("lastName");
    const name =
      get("name") || get("fullName") || [first, last].filter(Boolean).join(" ").trim() || "Website visitor";

    const email = get("email");
    const phone = get("phone");
    const message = get("message");
    const containerSize = get("containerSize") || get("size");
    const location = get("city") || get("location");
    const province = get("province") || get("state");
    const utm_source = get("utm_source");
    const utm_medium = get("utm_medium");
    const utm_campaign = get("utm_campaign");

    // Helpers
    async function b24(method, payload) {
      const r = await fetch(`${hook}${method}.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      }).then(x => x.json());
      return r;
    }

    // 1) Find or create contact
    async function findContact(filter) {
      const r = await b24("crm.contact.list", { filter, select: ["ID"] });
      return r?.result?.[0]?.ID;
    }

    let contactId;
    if (email) contactId = await findContact({ EMAIL: email });
    if (!contactId && phone) contactId = await findContact({ PHONE: phone });

    if (!contactId) {
      const add = await b24("crm.contact.add", {
        fields: {
          NAME: name,
          ASSIGNED_BY_ID: assignedById || undefined,
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [],
          SOURCE_ID: sourceId
        }
      });
      if (!add?.result) return res.status(500).json({ error: "Failed to create contact", details: add });
      contactId = add.result;
    }

    // 2) Create deal
    const title = `Website Request - ${containerSize || "Container"} - ${location || "Location unknown"}`;
    const comments = [
      message && `Message: ${message}`,
      containerSize && `Container size: ${containerSize}`,
      location && `Location: ${location}${province ? ", " + province : ""}`,
      phone && `Phone: ${phone}`,
      email && `Email: ${email}`,
      `Source site: new.storecan.ca`,
      utm_source && `UTM source: ${utm_source}`,
      utm_medium && `UTM medium: ${utm_medium}`,
      utm_campaign && `UTM campaign: ${utm_campaign}`
    ].filter(Boolean).join("\n");

    const dealAdd = await b24("crm.deal.add", {
      fields: {
        TITLE: title,
        CATEGORY_ID: categoryId,
        STAGE_ID: stageId,
        ASSIGNED_BY_ID: assignedById || undefined,
        CONTACT_ID: contactId,
        SOURCE_ID: sourceId,
        SOURCE_DESCRIPTION: "new.storecan.ca",
        COMMENTS: comments
      }
    });

    if (!dealAdd?.result) return res.status(500).json({ error: "Failed to create deal", details: dealAdd });

    return res.status(200).json({ ok: true, dealId: dealAdd.result, contactId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
