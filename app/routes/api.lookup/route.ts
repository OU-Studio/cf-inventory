// app/routes/api.lookup.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { asString, readBody } from "../../utils/api.server"; // adjust path if needed
import { resolveCustomerIdentity } from "../../utils/identity.server"; // adjust path if needed
import prisma from "../../db.server"; // or "../../db.server" depending on your structure

const EXT_ORIGIN = "https://extensions.shopifycdn.com";
const ADMIN_API_VERSION = "2025-10";

function allowOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return origin === EXT_ORIGIN ? origin : "*";
}

function corsHeaders(request: Request) {
  return {
    "Access-Control-Allow-Origin": allowOrigin(request),
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as Record<string, string>;
}

function corsJson(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

function corsNoContent(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  return corsJson(request, { error: "Method not allowed" }, 405);
}

// Prefer OFFLINE token; fallback to newest.
async function getShopAccessToken(shopDomain: string) {
  const offline = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true },
  });
  if (offline?.accessToken) return offline.accessToken;

  const any = await prisma.session.findFirst({
    where: { shop: shopDomain },
    select: { accessToken: true },
    orderBy: { expires: "desc" },
  });
  return any?.accessToken ?? null;
}

function normalizeGid(id: string, kind: "Product" | "ProductVariant") {
  if (!id) return null;
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/${kind}/${id}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

    const identity = await resolveCustomerIdentity(request);

    const accessToken = await getShopAccessToken(identity.shop.shop);
    if (!accessToken) {
      return corsJson(
        request,
        { error: "Missing offline access token for shop" },
        500
      );
    }

    const body = await readBody(request);

    const countryCodeRaw = (asString((body as any).countryCode) || "").trim().toUpperCase();
    const countryCode = countryCodeRaw && countryCodeRaw.length === 2 ? countryCodeRaw : null;

    const productIdsIn = Array.isArray((body as any).productIds) ? (body as any).productIds : [];
    const variantIdsIn = Array.isArray((body as any).variantIds) ? (body as any).variantIds : [];

    const productIds = productIdsIn
      .map((id: string) => normalizeGid(String(id || ""), "Product"))
      .filter(Boolean);

    const variantIds = variantIdsIn
      .map((id: string) => normalizeGid(String(id || ""), "ProductVariant"))
      .filter(Boolean);

    // nothing to do
    if (!productIds.length && !variantIds.length) {
      return corsJson(request, { productMap: {}, variantMap: {} }, 200);
    }

    const gql = `#graphql
  query Lookup($productIds: [ID!]!, $variantIds: [ID!]!, $country: CountryCode) {
    shop { currencyCode }

    products: nodes(ids: $productIds) {
      ... on Product {
        id
        title
        handle
  featuredImage {
    url
    altText
  }
      }
    }

    variants: nodes(ids: $variantIds) {
      ... on ProductVariant {
        id
        title
        sku
        product { id title handle }

        price  # Money scalar (no subfields)

        contextualPricing(context: { country: $country }) {
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
        }
      }
    }
  }
`;


    const resp = await fetch(
      `https://${identity.shop.shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: gql,
          variables: {
            productIds,
            variantIds,
            country: countryCode, // can be null; Shopify will just ignore contextualPricing
          },
        }),
      }
    );

    const json: any = await resp.json();

    if (json?.errors?.length) {
      return corsJson(
        request,
        {
          error: "GraphQL error",
          errors: json.errors,
          shop: identity.shop.shop,
          productIds,
          variantIds,
        },
        400
      );
    }

    const productMap: Record<string, any> = {};
    const variantMap: Record<string, any> = {};

    const products = Array.isArray(json?.data?.products) ? json.data.products : [];
    const variants = Array.isArray(json?.data?.variants) ? json.data.variants : [];

    for (const p of products) {
      if (p?.id) productMap[p.id] = p;
    }

    const shopCurrency = json?.data?.shop?.currencyCode ?? null;

for (const v of variants) {
  if (!v?.id) continue;

  const contextualPrice = v?.contextualPricing?.price || null;

  // v.price is a scalar (string/number-like)
  const baseAmount = v?.price != null ? String(v.price) : null;
  const basePrice =
    baseAmount && shopCurrency ? { amount: baseAmount, currencyCode: shopCurrency } : null;

  const finalPrice = contextualPrice || basePrice || null;

  variantMap[v.id] = {
    ...v,
    price: finalPrice, // always { amount, currencyCode } when possible
    compareAtPrice: v?.contextualPricing?.compareAtPrice || null,
  };
}


    return corsJson(request, { productMap, variantMap, countryCode }, 200);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
