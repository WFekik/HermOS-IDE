import { getCurrentUser } from "@/lib/session";
import { withErrorHandler, ok } from "@/app/api/_lib/helpers";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  const user = await getCurrentUser(req);
  return ok({ user });
});
