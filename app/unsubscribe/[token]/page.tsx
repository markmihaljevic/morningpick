import { unsubscribeByToken } from "@/lib/subscription";
import { UnsubscribeResult } from "../unsubscribe-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "Unsubscribe — Morningpick" };

export default async function UnsubscribeTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const done = await unsubscribeByToken(token);
  return <UnsubscribeResult done={done} />;
}
