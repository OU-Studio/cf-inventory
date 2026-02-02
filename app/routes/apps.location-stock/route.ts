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

  try {
    // hard env sanity FIRST
    const missing = [];
    if (!process.env.SHOPIFY_SHOP) missing.push("SHOPIFY_SHOP");
    if (!process.env.SHOPIFY_API_SECRET) missing.push("SHOPIFY_API_SECRET");
    if (!process.env.SHOPIFY_OFFLINE_TOKEN) missing.push("SHOPIFY_OFFLINE_TOKEN");
    if (!process.env.UK_LOCATION_ID) missing.push("UK_LOCATION_ID");
    if (!process.env.US_LOCATION_ID) missing.push("US_LOCATION_ID");

    if (missing.length) {
      console.error("location-stock missing env:", missing);
      return Response.json({ error: "Missing env vars", missing }, { status: 500 });
    }

    // ... keep the rest of your logic ...
  } catch (err: any) {
    console.error("location-stock fatal:", err?.stack || err?.message || err);

    // Always return JSON
    return new Response(
      JSON.stringify({
        error: "location-stock fatal",
        details: String(err?.message || err),
      }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
}

