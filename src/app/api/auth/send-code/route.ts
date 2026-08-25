import { withErrorHandler, apiError } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/** send-code disabled — local-first mode has no email authentication. */
export const POST = withErrorHandler(async () => {
  return apiError("Email authentication is not enabled in local-first mode.", 404);
});