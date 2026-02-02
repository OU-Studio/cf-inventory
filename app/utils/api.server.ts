import type { Session } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export function getPlaceholderCustomerKey(session: any) {
  const userId = session.onlineAccessInfo?.associated_user?.id;
  if (userId) return String(userId);
  return `offline:${session.shop}`;
}

export async function getShopCustomerAdmin(request: Request) {
  const { session, admin } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const customerKey = getPlaceholderCustomerKey(session);
  const user = session.onlineAccessInfo?.associated_user;

  const customer = await prisma.customer.upsert({
    where: { shopId_customerId: { shopId: shop.id, customerId: customerKey } },
    update: {
      email: user?.email ?? undefined,
      firstName: user?.first_name ?? undefined,
      lastName: user?.last_name ?? undefined,
    },
    create: {
      shopId: shop.id,
      customerId: customerKey,
      email: user?.email ?? null,
      firstName: user?.first_name ?? null,
      lastName: user?.last_name ?? null,
    },
  });

  return { session, admin, shop, customer };
}

export async function readBody(request: Request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await request.json().catch(() => ({}));
  }
  const form = await request.formData();
  const obj: Record<string, any> = {};
  for (const [k, v] of form.entries()) obj[k] = v;
  return obj;
}

export function asString(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

export function asInt(v: any, fallback = 1) {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : fallback;
  return Number.isFinite(n) ? n : fallback;
}
