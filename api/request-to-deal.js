// /api/request-to-deal.js
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const allowOrigin = process.env.ALLOWED_ORIGIN || "*";
    const origin = req.headers.origin || "";
    if (allowOrigin !== "*" && origin !== allowOrigin) {
      return res.status(403).json({ error: "Forbidden origin" });
    }

    const hook = process.env.BITRIX_WEBHOOK_REQUESTS;  // dedicated webhook for Framer requests
    if (!hook) return res.status(500).json({ error: "Missing BITRIX_WEBHOOK_REQUESTS" });

    const categoryId = Number(process.env.DEAL_CATEGORY_ID || 0);
    const stageId = process.env.DEAL_STAGE_ID || "";
    const assignedById = Number(process.env.ASSIGNED_BY_ID || 0);
    const sourceId = process.env.DEAL_SOURCE_ID || "WEB";

    const body = req.body || {};
    const {
      name = "", email = "", phone = "",
      message = "", containerSize = "",
      location = "", province = "",
      utm_source = "", utm_medium = "", utm_campaign = ""
    } = body;

    // 1) Find or create Contact
    let contactId;
    async function contactSearch(filter) {
      const r = await fetch(`${hook}crm.contact.list.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, select: ["ID"] })
      }).then(x => x.json());
      return r?.result?.[0]?.ID;
    }
    if (email) contactId = await contactSearch({ "EMAIL": email });
    if (!contactId && phone) contactId = await contactSearch({ "PHONE": phone });

    if (!contactId) {
      const add = await fetch(`${hook}crm.contact.add.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            NAME: name || "Website visitor",
            ASSIGNED_BY_ID: assignedById || undefined,
            EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
            PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [],
            SOURCE_ID: sourceId
          }
        })
      }).then(x => x.json());
      if (!add?.result) return res.status(500).json({ error: "Failed to create contact", details: add });
      contactId = add.result;
    }

    // 2) Create Deal in Category 6, Stage C6:NEW
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

    const dealAdd = await fetch(`${hook}crm.deal.add.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          TITLE: title,
          CATEGORY_ID: categoryId,
          STAGE_ID: stageId,
          ASSIGNED_BY_ID: assignedById || undefined,
          CONTACT_ID: contactId,
          SOURCE_ID: sourceId,
          COMMENTS: comments
          // Map your UF_CRM_* fields here if needed
        }
      })
    }).then(x => x.json());

    if (!dealAdd?.result) return res.status(500).json({ error: "Failed to create deal", details: dealAdd });

    res.setHeader("Access-Control-Allow-Origin", allowOrigin === "*" ? "*" : allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    return res.status(200).json({ ok: true, dealId: dealAdd.result, contactId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
