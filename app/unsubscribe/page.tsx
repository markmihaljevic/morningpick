import { unsubscribeByToken } from "@/lib/subscription";
import { UnsubscribeResult } from "./unsubscribe-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "Unsubscribe — Morningpick" };

// Legacy query-string variant (kept for old emails); new links use /unsubscribe/<token>.
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const done = token ? await unsubscribeByToken(token) : false;
  return <UnsubscribeResult done={done} />;
}
