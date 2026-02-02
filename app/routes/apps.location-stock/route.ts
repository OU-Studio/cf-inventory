import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP!;
const CLIENT_ID = process.env.SHOPIFY_API_KEY!;
const CLIENT_SECRET = process.env.SHOPIFY_API_SECRET!; // also used for proxy signature verification
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

const UK_LOCATION_ID = process.env.UK_LOCATION_ID!;
const US_LOCATION_ID = process.env.US_LOCATION_ID!;

/**
 * Shopify App Proxy signature verification
 */
function verifyProxySignature(url: URL) {
  const params = new URLSearchParams(url.searchParams);

  const signature = params.get("signature");
  if (!signature) return false;

  params.delete("signature");

  // sort params, concat key=value (no separators)
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const message = sorted.map(([k, v]) => `${k}=${v}`).join("");

  const digest = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(message)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch {
    return false;
  }
}

/**
 * In-memory token cache
 */
let cachedToken: { token: string; expiresAtMs: number } | null = null;

/**
 * Get an admin access token using client credentials.
 * If this fails, the returned error will include Shopify's exact response.
 */
async function getAdminAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - now > 60_000) {
    return cachedToken.token;
  }

  const resp = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const text = await resp.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}

  if (!resp.ok) {
    throw new Error(
      JSON.stringify({
        where: "token_exchange",
        status: resp.status,
        statusText: resp.statusText,
        body: data ?? text,
      })
    );
  }

  const token = data?.access_token;
  const expiresIn = data?.expires_in; // seconds (if present)

  if (!token) {
    throw new Error(
      JSON.stringify({
        where: "token_exchange",
        error: "No access_token in response",
        body: data ?? text,
      })
    );
  }

  const ttlMs =
    typeof expiresIn === "number" && expiresIn > 0
      ? expiresIn * 1000
      : 20 * 60 * 1000; // fallback 20m
  cachedToken = { token, expiresAtMs: now + ttlMs };

  return token;
}

/**
 * Admin API: fetch variant stock at one location
 */
async function getStockAtLocation(
  accessToken: string,
  variantId: string,
  locationId: string
) {
  const query = `
    query VariantInventoryAtLocation($variantGid: ID!, $locationGid: ID!) {
      productVariant(id: $variantGid) {
        inventoryItem {
          inventoryLevel(locationId: $locationGid) {
            available
          }
        }
      }
    }
  `;

  const variables = {
    variantGid: `gid://shopify/ProductVariant/${variantId}`,
    locationGid: `gid://shopify/Location/${locationId}`,
  };

  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}

  if (!resp.ok || data?.errors) {
    throw new Error(
      JSON.stringify({
        where: "admin_graphql",
        status: resp.status,
        statusText: resp.statusText,
        errors: data?.errors,
        body: data ?? text,
      })
    );
  }

  const qty =
    data?.data?.productVariant?.inventoryItem?.inventoryLevel?.available;

  return typeof qty === "number" ? qty : 0;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);

  // env sanity using ONLY your names
  const missing = [];
  if (!SHOP) missing.push("SHOPIFY_SHOP");
  if (!CLIENT_ID) missing.push("SHOPIFY_API_KEY");
  if (!CLIENT_SECRET) missing.push("SHOPIFY_API_SECRET");
  if (!UK_LOCATION_ID) missing.push("UK_LOCATION_ID");
  if (!US_LOCATION_ID) missing.push("US_LOCATION_ID");

  if (missing.length) {
    return Response.json({ error: "Server misconfigured", missing }, { status: 500 });
  }

  // 1) Verify App Proxy signature
  if (!verifyProxySignature(url)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 2) Inputs
  const variantId = url.searchParams.get("variant") || "";
  const country = (url.searchParams.get("country") || "").toUpperCase();

  if (!/^\d+$/.test(variantId)) {
    return Response.json({ error: "Missing/invalid variant" }, { status: 400 });
  }

  // 3) Country → location mapping
  const locationId =
    country === "GB" || country === "UK"
      ? UK_LOCATION_ID
      : country === "US"
        ? US_LOCATION_ID
        : UK_LOCATION_ID;

  try {
    const token = await getAdminAccessToken();
    const qty = await getStockAtLocation(token, variantId, locationId);

    return new Response(
      JSON.stringify({
        variantId: Number(variantId),
        country,
        locationId: Number(locationId),
        qty,
        available: qty > 0,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=15",
        },
      }
    );
  } catch (err: any) {
    return Response.json(
      { error: "Inventory proxy failed", details: String(err?.message || err) },
      { status: 502 }
    );
  }
}
