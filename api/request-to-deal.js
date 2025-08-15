// api/request-to-deal.js
// Safe stub: GET always OK. POST just echoes back.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, method: req.method, stage: "stub-get" });
    }
    // For POST, don't touch Bitrix yet. Just return payload to prove it runs.
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return { raw: req.body }; } })() : (req.body || {});
    return res.status(200).json({ ok: true, method: "POST", received: body || null });
  } catch (e) {
    return res.status(500).json({ error: "CRASH", message: String(e?.message || e) });
  }
}
