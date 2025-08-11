// /api/lead-to-bitrix.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (!b.email && !b.phone) return res.status(400).json({ error: "Email or phone required" });

    const fields = {
      TITLE: "Website lead",
      NAME: b.first_name || "",
      LAST_NAME: b.last_name || "",
      SOURCE_ID: "WEB",
      COMMENTS: [
        b.message ? `Message: ${b.message}` : null,
        b.container_size ? `Container size: ${b.container_size}` : null,
        b.condition ? `Condition: ${b.condition}` : null,
        b.postal_code ? `Delivery postal code: ${b.postal_code}` : null,
        b.page_url ? `Page: ${b.page_url}` : null
      ].filter(Boolean).join("\n"),
      UTM_SOURCE: b.utm_source || "",
      UTM_MEDIUM: b.utm_medium || "",
      UTM_CAMPAIGN: b.utm_campaign || "",
      UTM_TERM: b.utm_term || "",
      UTM_CONTENT: b.utm_content || ""
    };
    if (b.email) fields.EMAIL = [{ VALUE: b.email, VALUE_TYPE: "WORK" }];
    if (b.phone) fields.PHONE = [{ VALUE: String(b.phone).replace(/[^\d+]/g, ""), VALUE_TYPE: "WORK" }];

    const url = `${process.env.B24_WEBHOOK_BASE}crm.lead.add.json`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, params: { REGISTER_SONET_EVENT: "Y" } })
    });
    const j = await r.json();
    if (j.error) return res.status(502).json({ error: j.error, description: j.error_description });
    return res.status(200).json({ status: "created", id: j.result });
  } catch (e) {
    return res.status(500).json({ error: "Internal error" });
  }
}
