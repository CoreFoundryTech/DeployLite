import { cookies } from "next/headers";
import { getAuthApiBaseUrl, loadAuthSession } from "./auth-boundary";

export async function loadRequestAuthSession() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

  return loadAuthSession({ apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}
