import crypto from "crypto";
import shopify, { sessionStorage } from "../../shopify.server";

const PROXY_SECRET = process.env.SHOPIFY_API_SECRET || "";
const API_VERSION =
  process.env.SHOPIFY_API_VERSION ||
  "2026-01";

const UK_LOCATION_ID = process.env.UK_LOCATION_ID!;
const US_LOCATION_ID = process.env.US_LOCATION_ID!;

function verifyProxySignature(url: URL) {
  if (!PROXY_SECRET) return false;

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

async function getOfflineAccessTokenForShop(shop: string): Promise<string | null> {
  // PrismaSessionStorage supports this in the Shopify app templates:
  const sessions = await sessionStorage.findSessionsByShop(shop);

  // pick an OFFLINE session (isOnline === false)
  const offline = sessions.find((s: any) => s && s.isOnline === false && s.accessToken);

  console.log("sessions found:", sessions.map(s => ({ id: s.id, isOnline: s.isOnline })));


  return offline?.accessToken || null;
}

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

  if (!verifyProxySignature(url)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const variantId = url.searchParams.get("variant") || "";
  const country = (url.searchParams.get("country") || "").toUpperCase();
  const shop = (url.searchParams.get("shop") || "").trim();

  if (!shop) return Response.json({ error: "Missing shop" }, { status: 400 });
  if (!/^\d+$/.test(variantId)) {
    return Response.json({ error: "Missing/invalid variant" }, { status: 400 });
  }

  const locationId =
    country === "GB" || country === "UK"
      ? UK_LOCATION_ID
      : country === "US"
        ? US_LOCATION_ID
        : UK_LOCATION_ID;

  const accessToken = await getOfflineAccessTokenForShop(shop);

  if (!accessToken) {
    // This is your current situation
    return Response.json(
      {
        error: "No offline session stored for shop",
        shop,
        hint:
          "Open the embedded app in Shopify admin (or reinstall) to complete offline auth and store a session in Prisma.",
      },
      { status: 401 }
    );
  }

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
          "Content-Type": "application/json; charset=utf-8",
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
