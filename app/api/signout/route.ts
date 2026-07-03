import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { DESK_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

/** Deliberate sign-out: clear the desk session and land on the homepage. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const store = await cookies();
  store.delete(DESK_COOKIE);
  return NextResponse.redirect(`${config().APP_URL}/`, 303);
}
