import { cookies } from "next/headers";
import { getAuthApiBaseUrl, loadAuthSession, loadBootstrapStatus, loadDashboardMetadata, loadDeploymentLogMetadata } from "./auth-boundary";

async function getRequestCookieHeader() {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function loadRequestAuthSession() {
  const cookieHeader = await getRequestCookieHeader();

  return loadAuthSession({ apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function loadRequestBootstrapStatus() {
  const cookieHeader = await getRequestCookieHeader();

  return loadBootstrapStatus({ apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function loadRequestDashboardMetadata() {
  const cookieHeader = await getRequestCookieHeader();

  return loadDashboardMetadata({ apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function loadRequestDeploymentLogMetadata(deploymentId: string) {
  const cookieHeader = await getRequestCookieHeader();

  return loadDeploymentLogMetadata(deploymentId, { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}
