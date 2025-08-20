// /api/quote-to-deal.js  — INVOICE REQUEST (Invoice pipeline)
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

  try {
    const base = process.env.B24_WEBHOOK_BASE; // https://.../rest/USER/TOKEN/
    if (!base) return res.status(500).json({ error: "Missing B24_WEBHOOK_BASE" });

    const b = await readBody(req);
    const get = k => (b?.[k] ?? "").toString();

    // Normalized fields
    const name           = get("name") || get("fullName") ||
                           [get("firstName"), get("lastName")].filter(Boolean).join(" ").trim() ||
                           (get("phone") ? "Caller" : "Visitor");
    const email          = get("email");
    const phone          = get("phone");
    const message        = get("message");
    const city           = get("city") || get("location");
    const province       = get("province") || get("state");
    const container_size = get("container_size") || get("containerSize") || get("size");
    const condition      = get("condition");
    const page_url       = get("page_url") || get("page");
    const utm_source     = get("utm_source");
    const utm_medium     = get("utm_medium");
    const utm_campaign   = get("utm_campaign");
    const utm_term       = get("utm_term");
    const utm_content    = get("utm_content");

    // Helper: safe Bitrix call (handles trailing slash)
    const b24 = (method, params) => {
      const endpoint = base.endsWith("/") ? `${base}${method}.json` : `${base}/${method}.json`;
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
          NAME: name,
          OPENED: "Y",
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : []
        }
      });
      if (contactCreate?.result) contactId = contactCreate.result;
    }

    // 2) Build comments
    const comments = [
      "Form: invoice request",
      message && `Message: ${message}`,
      container_size && `Container: ${container_size}`,
      condition && `Condition: ${condition}`,
      city || province ? `Location: ${[city, province].filter(Boolean).join(", ")}` : "",
      email && `Email: ${email}`,
      phone && `Phone: ${phone}`,
      page_url && `Page: ${page_url}`,
      (utm_source || utm_medium || utm_campaign || utm_term || utm_content) &&
        `UTM: source=${utm_source || ""}, medium=${utm_medium || ""}, campaign=${utm_campaign || ""}, term=${utm_term || ""}, content=${utm_content || ""}`
    ].filter(Boolean).join("\n");

    // 3) Create deal in Invoice pipeline (env-driven)
    const CATEGORY_ID = Number(
      process.env.INVOICE_CATEGORY_ID ??
      process.env.QUOTE_CATEGORY_ID ?? 6
    );
    const STAGE_ID =
      process.env.INVOICE_STAGE_ID ??
      process.env.QUOTE_STAGE_ID ??
      (CATEGORY_ID === 0 ? "NEW" : `C${CATEGORY_ID}:NEW`);

    const assignedById = Number(process.env.QUOTE_ASSIGNED_BY_ID || process.env.ASSIGNED_BY_ID || 0);
    const sourceId     = process.env.QUOTE_SOURCE_ID || process.env.DEAL_SOURCE_ID || "WEB";

    const titleBits = [name || phone || "Invoice request", container_size || "", city || province || ""]
      .filter(Boolean)
      .join(" | ");

    const dealAdd = await b24("crm.deal.add", {
      fields: {
        TITLE: `Invoice Request: ${titleBits}`.slice(0, 250),
        CATEGORY_ID: CATEGORY_ID,
        STAGE_ID: STAGE_ID,
        ASSIGNED_BY_ID: assignedById || undefined,
        CONTACT_ID: contactId || undefined,
        SOURCE_ID: sourceId,
        SOURCE_DESCRIPTION: "new.storecan.ca",
        COMMENTS: comments
      }
    });

    if (dealAdd?.result) {
      return res.status(200).json({ ok: true, deal_id: dealAdd.result });
    }
    return res.status(500).json({ error: "Failed to create deal", raw: dealAdd });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
