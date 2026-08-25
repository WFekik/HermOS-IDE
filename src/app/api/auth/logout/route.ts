import { withErrorHandler, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/** No-op logout — local-first mode has no session to destroy. */
export const POST = withErrorHandler(async () => {
  return ok({ ok: true, message: "No session to sign out from." });
});
