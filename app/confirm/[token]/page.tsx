import { confirmSubscriber } from "@/lib/subscription";
import { ConfirmResult } from "../confirm-result";

export const dynamic = "force-dynamic";

export const metadata = { title: "Confirm — Morningpick" };

// Path-based token (primary): query-string tokens can be corrupted by
// quoted-printable encoding in some email clients.
export default async function ConfirmTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await confirmSubscriber(token);
  return <ConfirmResult result={result} />;
}
