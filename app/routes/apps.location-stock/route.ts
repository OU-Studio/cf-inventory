import crypto from "crypto";
import shopify from "../../shopify.server";

const PROXY_SECRET = process.env.SHOPIFY_API_SECRET!;

const API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  "2026-01";

const UK_LOCATION_ID = process.env.UK_LOCATION_ID!;
const US_LOCATION_ID = process.env.US_LOCATION_ID!;

/**
 * Shopify App Proxy signature verification
 */
function verifyProxySignature(url: URL) {
  if (!PROXY_SECRET) return false;

  const params = new URLSearchParams(url.searchParams);
  const signature = params.get("signature");
  if (!signature) return false;

  params.delete("signature");

  // Shopify expects: sort params by key, concat key=value with NO separators
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const message = sorted.map(([k, v]) => `${k}=${v}`).join("");

  const digest = crypto
    .createHmac("sha256", PROXY_SECRET)
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
 * Load offline session token for a shop using your app's session storage.
 * Works across template versions by trying multiple offline-id strategies.
 */
async function loadOfflineAccessToken(shop: string): Promise<string | null> {
  // Strategy 1: preferred helper if available
  try {
    const getOfflineId = (shopify as any)?.api?.session?.getOfflineId;
    if (typeof getOfflineId === "function") {
      const offlineId = getOfflineId(shop);
      const session = await (shopify as any).sessionStorage.loadSession(offlineId);
      if (session?.accessToken) return session.accessToken;
    }
  } catch {}

  // Strategy 2: common id format
  try {
    const offlineId = `offline_${shop}`;
    const session = await (shopify as any).sessionStorage.loadSession(offlineId);
    if (session?.accessToken) return session.accessToken;
  } catch {}

  return null;
}


/**
 * Admin API: fetch variant stock at one location (using OFFLINE token)
 */
async function getStockAtLocation(
  shop: string,
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

  const resp = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
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
  } catch {
    data = null;
  }

  if (!resp.ok || data?.errors) {
    throw new Error(
      JSON.stringify({
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

/**
 * ✅ App Proxy GET handler (React Router / Shopify app template)
 */
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);

  // 1) Verify App Proxy signature
  if (!verifyProxySignature(url)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 2) Inputs from proxy request
  const variantId = url.searchParams.get("variant") || "";
  const country = (url.searchParams.get("country") || "").toUpperCase();
  const shop = (url.searchParams.get("shop") || "").trim(); // Shopify always includes this on proxy calls

  if (!shop) {
    return Response.json({ error: "Missing shop" }, { status: 400 });
  }

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

  if (!locationId) {
    return Response.json({ error: "Missing location env vars" }, { status: 500 });
  }

  // 4) Load offline token
  const accessToken = await loadOfflineAccessToken(shop);
  if (!accessToken) {
    // This means install didn’t complete, session storage isn't persisted, or wrong session id strategy.
    return Response.json(
      { error: "No offline session token found for shop", shop },
      { status: 401 }
    );
  }

  // 5) Fetch inventory
  try {
    const qty = await getStockAtLocation(shop, accessToken, variantId, locationId);

    return new Response(
      JSON.stringify({
        variantId: Number(variantId),
        country,
        shop,
        locationId: Number(locationId),
        qty,
        available: qty > 0,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Helps rate limits massively
          "Cache-Control": "public, max-age=15",
        },
      }
    );
  } catch (err: any) {
    return Response.json(
      { error: "Admin API error", details: String(err?.message || err) },
      { status: 502 }
    );
  }
}
