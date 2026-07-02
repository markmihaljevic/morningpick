import { confirmSubscriber } from "@/lib/subscription";
import { ConfirmResult } from "./confirm-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "Confirm — Morningpick" };

// Legacy query-string variant (kept for old emails); new links use /confirm/<token>.
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = token ? await confirmSubscriber(token) : "invalid";
  return <ConfirmResult result={result} />;
}
