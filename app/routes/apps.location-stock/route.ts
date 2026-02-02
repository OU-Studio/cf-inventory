import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP!;
const ADMIN_TOKEN = process.env.SHOPIFY_OFFLINE_TOKEN!;
const PROXY_SECRET = process.env.SHOPIFY_API_SECRET || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01"; 

const UK_LOCATION_ID = process.env.UK_LOCATION_ID!; 
const US_LOCATION_ID = process.env.US_LOCATION_ID!;

function verifyProxySignature(url: URL) {
  const params = new URLSearchParams(url.searchParams);
  const signature = params.get("signature");
  if (!signature) return false;

  params.delete("signature");

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

async function getStockAtLocation(variantId: string, locationId: string) {
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
      "X-Shopify-Access-Token": ADMIN_TOKEN,
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

  // Sanity
  if (!SHOP || !ADMIN_TOKEN) {
    return Response.json(
      { error: "Missing SHOPIFY_SHOP or HOST token" },
      { status: 500 }
    );
  }

  // Verify App Proxy signature
  if (!verifyProxySignature(url)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const variantId = url.searchParams.get("variant") || "";
  const country = (url.searchParams.get("country") || "").toUpperCase();

  if (!/^\d+$/.test(variantId)) {
    return Response.json({ error: "Missing/invalid variant" }, { status: 400 });
  }

  const locationId =
    country === "GB" || country === "UK"
      ? UK_LOCATION_ID
      : country === "US"
        ? US_LOCATION_ID
        : UK_LOCATION_ID;

  try {
    const qty = await getStockAtLocation(variantId, locationId);

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
    console.error("location-stock failed:", err?.message || err);
    return Response.json(
      { error: "Admin API error", details: String(err?.message || err) },
      { status: 502 }
    );
  }
}
