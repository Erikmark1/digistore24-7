/*
 * Netlify Function: POST /.netlify/functions/pinterest-event
 * Forwards one web event to Pinterest's Conversions API.
 *
 * Environment variables (Netlify > Site settings > Environment variables):
 *   PINTEREST_ACCESS_TOKEN  - required, conversion access token from Ads Manager
 *   PINTEREST_AD_ACCOUNT_ID - optional, defaults to 549770974775
 *   PINTEREST_TEST_MODE     - "1" sends ?test=true (validated, not recorded)
 *   PINTEREST_DRY_RUN       - "1" returns the payload without calling Pinterest
 */
import { createHash } from "node:crypto";

const AD_ACCOUNT_ID = process.env.PINTEREST_AD_ACCOUNT_ID || "549770974775";
const ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN || "";
const DRY_RUN = process.env.PINTEREST_DRY_RUN === "1";
const TEST_MODE = process.env.PINTEREST_TEST_MODE === "1";

const EVENT_MAP = {
  PageVisit: "page_visit",
  Lead: "lead",
  InitiateCheckout: "initiate_checkout",
  Checkout: "checkout"
};

const MAX_BODY = 4096;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function originAllowed(request) {
  const source = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!source) return request.headers.get("sec-fetch-site") === "same-origin";

  let host;
  try {
    host = new URL(source).hostname;
  } catch {
    return false;
  }

  const ownHost = new URL(request.url).hostname;
  return (
    host === ownHost ||
    host.endsWith(".netlify.app") ||
    host === "localhost" ||
    host === "127.0.0.1"
  );
}

function sourceUrl(value, epik) {
  if (typeof value !== "string") return undefined;

  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  url.hash = "";
  if (epik && !url.searchParams.get("epik")) url.searchParams.set("epik", epik);
  return url.toString().slice(0, 2048);
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  if (!originAllowed(request)) {
    return json(403, { error: "forbidden_origin" });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return json(413, { error: "payload_too_large" });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body || typeof body !== "object") {
    return json(400, { error: "invalid_body" });
  }

  const eventName = EVENT_MAP[body.name];
  if (!eventName) {
    return json(400, { error: "unsupported_event" });
  }

  const eventId = clean(body.event_id, 128);
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(eventId)) {
    return json(400, { error: "invalid_event_id" });
  }

  const email = clean(body.email, 254);
  const ip =
    request.headers.get("x-nf-client-connection-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const userAgent = clean(request.headers.get("user-agent"), 512);
  const epik = clean(body.epik, 500);

  const userData = {};
  if (email && email.includes("@")) {
    userData.em = [sha256(email.toLowerCase())];
  }
  if (epik) userData.click_id = epik;
  if (ip) userData.client_ip_address = ip;
  if (userAgent) userData.client_user_agent = userAgent;

  /* Pinterest requires em, hashed_maids, or ip + user agent. */
  if (!userData.em && !(userData.client_ip_address && userData.client_user_agent)) {
    return json(422, { error: "missing_user_data" });
  }

  const event = {
    event_name: eventName,
    action_source: "web",
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    partner_name: "direct",
    user_data: userData
  };

  const url = sourceUrl(body.url, epik);
  if (url) event.event_source_url = url;

  const customData = {};
  const value = Number(body.value);
  if (Number.isFinite(value) && value >= 0 && value <= 100000) {
    customData.value = value.toFixed(2);
    customData.currency = "USD";
  }
  const productId = clean(body.product_id, 64);
  if (productId) customData.content_ids = [productId];
  const contentName = clean(body.content_name, 128);
  if (contentName) customData.content_name = contentName;
  if (Object.keys(customData).length) event.custom_data = customData;

  if (DRY_RUN) {
    return json(200, { ok: true, dry_run: true, event });
  }
  if (!ACCESS_TOKEN) {
    console.error("pinterest-event: PINTEREST_ACCESS_TOKEN is not set");
    return json(503, { error: "not_configured" });
  }

  const endpoint =
    `https://api.pinterest.com/v5/ad_accounts/${encodeURIComponent(AD_ACCOUNT_ID)}/events` +
    (TEST_MODE ? "?test=true" : "");

  let response;
  let text;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: [event] }),
      signal: AbortSignal.timeout(8000)
    });
    text = await response.text();
  } catch (error) {
    console.error("pinterest-event: request failed", error);
    return json(502, { error: "pinterest_unreachable" });
  }

  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { raw: text.slice(0, 1000) };
  }

  if (!response.ok) {
    console.error("pinterest-event: API error", response.status, text.slice(0, 1000));
  }

  return json(response.ok ? 200 : 502, {
    ok: response.ok,
    status: response.status,
    pinterest: result
  });
};
