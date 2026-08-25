import { withErrorHandler, apiError } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

/** NextAuth endpoint disabled — local-first mode has no authentication. */
export const GET = withErrorHandler(async () => {
  return apiError("Authentication is not enabled in local-first mode.", 404);
});

export const POST = GET;
