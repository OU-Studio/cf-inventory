import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate, registerWebhooks } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // ensures offline token + webhooks are set up after install/login
  await registerWebhooks({ session });

  return redirect("/app");
}
