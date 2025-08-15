// /api/request-to-deal.js
// Creates a Bitrix DEAL in "Invoice Request" from your Tally form.
// Fix: convert Tally option IDs to readable text so details show up.

function splitName(full){ if(!full) return {first:"",last:""}; const p=String(full).trim().split(/\s+/); return { first:p.shift()||"", last:p.join(" ") }; }
function normalizePhone(s){ if(!s) return ""; return String(s).replace(/[^\d+]/g,""); }
function asArray(v){ if(v==null) return []; return Array.isArray(v)?v:[v]; }

// Turn Tally field value into human text
function pickValue(f){
  const v = f?.value;

  // Case 1: value is an object like { label: "Delivery" }
  if (v && typeof v === "object" && "label" in v) return v.label;

  // Case 2: value is an array of option IDs (multi-select)
  if (Array.isArray(v) && Array.isArray(f?.options)) {
    const byId = new Map((f.options||[]).map(o => [String(o.id), o.text || o.label || String(o.id)]));
    return v.map(id => byId.get(String(id)) || String(id)).join(", ");
  }

  // Case 3: value is a single option ID (dropdown)
  if ((typeof v === "string" || typeof v === "number") && Array.isArray(f?.options)) {
    const opt = (f.options||[]).find(o => String(o.id) === String(v));
    if (opt) return opt.text || opt.label || String(v);
  }

  // Case 4: plain text
  return v ?? "";
}

// Map Tally webhook into simple key/value pairs
function mapFromTally(body){
  if (!body || !body.data || !Array.isArray(body.data.fields)) return null;
  const out = {};
  for (const f of body.data.fields) {
    const rawLabel = String(f.key || f.label || "");
    const label = rawLabel.toLowerCase().trim();
    const val = pickValue(f);
    const set = (...names)=> names.forEach(n => { if (!(n in out)) out[n] = val; });

    // Contact / billing
    if (label.includes("first") && label.includes("name")) set("billing_first_name","name");
    else if (label === "name") set("name","billing_first_name");
    else if (label.includes("last") && label.includes("name")) set("billing_last_name","last_name");
    else if (label.includes("email")) set("billing_email","email");
    else if (label.includes("phone")) set("billing_phone","phone");
    else if (label.includes("company")) set("company","company_name");
    else if (label.includes("billing address") || label === "address" || label.includes("address")) set("billing_address_1","billing_address");
    else if (label === "city") set("billing_city","city");
    else if (label.includes("province") || label.includes("state")) set("billing_state","province");
    else if (label.includes("postal") || label.includes("postcode") || label.includes("zip")) set("billing_postcode","postal_code");

    // Delivery / pickup
    else if (label === "method" || label.includes("delivery method") || (label.includes("method") && label.includes("delivery"))) set("delivery_method");
    else if (label === "location" || label.includes("depot") || label.includes("pickup city")) set("pickup_city","depot_location","depot_city","pickup_point");
    else if (label.includes("container doors direction")) set("door_direction");
    else if (label.includes("delivery address") || label.includes("map pin") || label.includes("coordinates")) set("delivery_map_pin");

    // Site contact
    else if (label.includes("site contact name")) set("site_contact_name");
    else if (label.includes("site contact phone")) set("site_contact_phone");
    else if (label.includes("site contact")) set("site_contact");

    // Items
    else if (label.includes("container") && label.includes("type")) set("container_type","container_size");
    else if (label === "qty" || label.includes("quantity")) set("qty","quantity");
    else if (label.includes("condition")) set("condition");

    // Notes
    else if (label.includes("comment") || label.includes("note") || label.includes("message")) set("order_note","message");
  }

  // Tally meta
  if (body.data.hidden) Object.assign(out, body.data.hidden);
  if (body.data.url && !out.page_url) out.page_url = body.data.url;
  if (body.data.ip && !out.ip) out.ip = body.data.ip;
  if (body.data.userAgent && !out.user_agent) out.user_agent = body.data.userAgent;

  return out;
}

export default async function handler(req,res){
  // CORS
  const origins=(process.env.ALLOWED_ORIGINS||process.env.ALLOWED_ORIGIN||"").split(",").map(s=>s.trim()).filter(Boolean);
  const reqOrigin=req.headers.origin||"";
  const allow=origins.length===0||origins.includes("*")||origins.includes(reqOrigin);
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Origin", allow ? (origins.includes("*")?"*":reqOrigin) : (origins[0] || "*"));
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  // Env
  const base=process.env.B24_WEBHOOK_BASE;
  const DEAL_CATEGORY_ID=Number(process.env.DEAL_CATEGORY_ID||0);
  const DEAL_STAGE_ID=process.env.DEAL_STAGE_ID||"";
  if (!base || !DEAL_STAGE_ID) return res.status(500).json({error:"Missing Bitrix env vars"});

  // Parse body
  let b={};
  try { b = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{}); }
  catch {
    const raw = typeof req.body === "string" ? req.body : "";
    try { b = Object.fromEntries(new URLSearchParams(raw)); } catch { b = {}; }
  }

  // Map Tally
  const maybeTally = mapFromTally(b);
  if (maybeTally) b = maybeTally;

  // Contact
  const name = b.name || b.billing_first_name || "";
  const { first:firstName, last:lastName } = splitName(name);
  const email = b.email || b.billing_email || "";
  const phone = normalizePhone(b.phone || b.billing_phone);

  // Billing
  const billing_address = b.billing_address_1 || b.billing_address || "";
  const billing_city = b.billing_city || "";
  const billing_state = b.billing_state || b.province || "";
  const billing_postal = b.billing_postcode || b.postal_code || "";

  // Delivery / pickup
  const delivery_method_raw = b.delivery_method || "";
  const pickup_city = b.pickup_city || b.depot_location || b.depot_city || b.pickup_point || "";
  const door_direction = b.door_direction || "";
  const delivery_map_pin = b.delivery_map_pin || "";

  // Site contact
  const site_contact_name  = b.site_contact_name || (b.site_contact ? String(b.site_contact).split(" - ")[0] : "");
  const site_contact_phone = normalizePhone(b.site_contact_phone || (b.site_contact ? String(b.site_contact).split(" - ").slice(-1)[0] : ""));

  // Items
  const ctArr = asArray(b["container_type[]"] ?? b.container_type ?? b.container_size);
  const qArr  = asArray(b["qty[]"] ?? b.qty ?? b.quantity);
  const cond  = b.condition || "";
  const items = [];
  const n = Math.max(ctArr.length, qArr.length, 1);
  for (let i=0;i<n;i++){
    const t = (ctArr[i] ?? ctArr[0] ?? "").toString().trim();
    const q = (qArr[i]  ?? qArr[0]  ?? "").toString().trim();
    if (t && t.toLowerCase() !== "none") items.push([q || "1","x",t,cond?`(${cond})`:""].filter(Boolean).join(" "));
  }

  const message  = b.order_note || b.message || "Invoice Request";
  const company  = b.company || b.company_name || "";
  const page_url = b.page_url || b.pageUrl || b._wp_http_referer || "";
  const utm_source   = b.utm_source   || b.utmSource   || "";
  const utm_medium   = b.utm_medium   || b.utmMedium   || "";
  const utm_campaign = b.utm_campaign || b.utmCampaign || "";
  const utm_term     = b.utm_term     || b.utmTerm     || "";
  const utm_content  = b.utm_content  || b.utmContent  || "";
  const ip = b.ip || ""; const user_agent = b.user_agent || "";

  // Bitrix helper
  async function b24(method,payload,attempt=0){
    const r = await fetch(`${base}${method}.json`,{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    const status = r.status; const j = await r.json().catch(()=>({}));
    if ((status===429 || status>=500) && attempt<3){ await new Promise(rs=>setTimeout(rs,Math.pow(2,attempt)*300)); return b24(method,payload,attempt+1); }
    if (j.error) throw new Error(`${j.error}: ${j.error_description||""}`);
    return j.result;
  }

  // Link contact only if we have an email or phone
  let contactId = 0;
  if (email || phone) {
    try{
      const type = email ? "EMAIL" : "PHONE";
      const values = email ? [email] : [phone];
      const dup = await b24("crm.duplicate.findbycomm",{ entity_type:"CONTACT", type, values });
      if (dup?.CONTACT?.length) contactId = dup.CONTACT[0];
      else {
        const contactFields = {
          NAME:firstName || "",
          LAST_NAME:lastName || "",
          EMAIL: email ? [{VALUE:email, VALUE_TYPE:"WORK"}] : undefined,
          PHONE: phone ? [{VALUE:phone, VALUE_TYPE:"WORK"}] : undefined,
          COMPANY_TITLE: company || undefined
        };
        contactId = await b24("crm.contact.add",{ fields:contactFields });
      }
    }catch { contactId = 0; }
  }

  // Build readable COMMENTS
  const parts = [
    "Form: invoice_request",
    items.length ? `Container type:\n- ${items.join("\n- ")}` : null,
    `Message: ${message}`,
    "",
    "Billing information:",
    (firstName || lastName) ? `Name: ${[firstName,lastName].filter(Boolean).join(" ")}` : null,
    email ? `Email: ${email}` : null,
    phone ? `Phone number: ${phone}` : null,
    billing_address ? `Billing address: ${billing_address}` : null,
    billing_state ? `Province: ${billing_state}` : null,
    billing_city ? `City: ${billing_city}` : null,
    billing_postal ? `Postal: ${billing_postal}` : null,
    "",
    "Delivery:",
    delivery_method_raw ? `Method: ${delivery_method_raw}` : null,
    pickup_city ? `Location: ${pickup_city}` : null,
    door_direction ? `Container doors direction for pickup: ${door_direction}` : null,
    delivery_map_pin ? `Delivery address/Map Pin/Coordinates: ${delivery_map_pin}` : null,
    (site_contact_name || site_contact_phone) ? `Site Contact: ${[site_contact_name,site_contact_phone].filter(Boolean).join(" - ")}` : null,
    "",
    "Meta:",
    page_url ? `Referer: ${page_url}` : null,
    ip ? `IP: ${ip}` : null,
    user_agent ? `User-Agent: ${user_agent}` : null,
    utm_source ? `UTM Source: ${utm_source}` : null,
    utm_medium ? `UTM Medium: ${utm_medium}` : null,
    utm_campaign ? `UTM Campaign: ${utm_campaign}` : null,
    utm_term ? `UTM Term: ${utm_term}` : null,
    utm_content ? `UTM Content: ${utm_content}` : null
  ];
  const comments = parts.filter(Boolean).join("\n");

  const fields = {
    TITLE: "Invoice Request",
    CATEGORY_ID: DEAL_CATEGORY_ID || undefined,
    STAGE_ID: DEAL_STAGE_ID,
    CONTACT_ID: contactId || undefined,
    SOURCE_ID: "WEB",
    COMMENTS: comments
  };

  try {
    const id = await b24("crm.deal.add", { fields, params: { REGISTER_SONET_EVENT: "Y" } });
    return res.status(200).json({ status:"created", id });
  } catch (e) {
    return res.status(502).json({ error:"Bitrix error", message:String(e.message||e) })
