// Demo-request lead proxy: receives the marketing site's form POST and creates
// a Company + Person in Ember's Twenty CRM instance. The Twenty API key lives
// here (Railway env vars), never in the static site.
const http = require("http");

const PORT = process.env.PORT || 3000;
const TWENTY_API_URL = (process.env.TWENTY_API_URL || "").replace(/\/+$/, "");
const TWENTY_API_KEY = process.env.TWENTY_API_KEY || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://bwilly79.github.io")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const configured = () => Boolean(TWENTY_API_URL && TWENTY_API_KEY);

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function twenty(path, payload) {
  const resp = await fetch(`${TWENTY_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TWENTY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = JSON.stringify(json).slice(0, 500);
    throw new Error(`Twenty ${path} -> ${resp.status}: ${detail}`);
  }
  // Twenty REST responses nest the record differently across versions; dig for an id.
  const d = json?.data ?? json;
  return d?.id ?? Object.values(d || {}).find((v) => v && typeof v === "object" && v.id)?.id ?? null;
}

async function createLead({ agency, name, email }) {
  let companyId = null;
  try {
    companyId = await twenty("/rest/companies", { name: agency });
  } catch (err) {
    // A duplicate or validation failure on the company must not lose the lead.
    console.error("company create failed:", err.message);
  }
  const parts = name.trim().split(/\s+/);
  const firstName = parts.shift() || name.trim();
  const lastName = parts.join(" ");
  const person = {
    name: { firstName, lastName },
    emails: { primaryEmail: email },
  };
  if (companyId) person.companyId = companyId;
  await twenty("/rest/people", person);
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === "GET") {
    return send(res, 200, cors, { ok: true, configured: configured() });
  }
  if (req.method !== "POST" || !req.url.startsWith("/demo-request")) {
    return send(res, 404, cors, { ok: false, error: "not found" });
  }
  if (!configured()) {
    return send(res, 503, cors, { ok: false, error: "CRM not configured yet" });
  }
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 10_000) req.destroy();
  });
  req.on("end", async () => {
    try {
      const body = JSON.parse(raw || "{}");
      const agency = String(body.agency || "").trim().slice(0, 200);
      const name = String(body.name || "").trim().slice(0, 200);
      const email = String(body.email || "").trim().slice(0, 320);
      if (!agency || !name || !/.+@.+\..+/.test(email)) {
        return send(res, 400, cors, { ok: false, error: "missing or invalid fields" });
      }
      await createLead({ agency, name, email });
      console.log(`lead created: ${name} <${email}> (${agency})`);
      return send(res, 200, cors, { ok: true });
    } catch (err) {
      console.error("lead failed:", err.message);
      return send(res, 502, cors, { ok: false, error: "upstream failure" });
    }
  });
});

server.listen(PORT, () => console.log(`lead-proxy listening on ${PORT}, configured=${configured()}`));
