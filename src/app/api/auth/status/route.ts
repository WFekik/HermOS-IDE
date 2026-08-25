import { withErrorHandler, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/** Always reports local-first mode — no OAuth providers configured. */
export const GET = withErrorHandler(async () => {
  return ok({ google: false, email: false, local: true });
});
