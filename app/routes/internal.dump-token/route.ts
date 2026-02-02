import { authenticate } from "../../shopify.server";

export async function loader({ request }: { request: Request }) {
  // Requires you to be in Shopify admin and authenticated
  const { session } = await authenticate.admin(request);

  // If you want OFFLINE token, ensure you are looking at an offline session.
  // In many templates this session is online. If so, you’ll need the offline session from storage.
  return Response.json({
    shop: session.shop,
    isOnline: session.isOnline,
    accessToken: session.accessToken,
  });
}
