import { cookies } from "next/headers";
import {
  createProject,
  deleteProject,
  getAuthApiBaseUrl,
  loadAuthSession,
  loadBootstrapStatus,
  loadDashboardMetadata,
  loadDeploymentLogMetadata,
  loadProjectDetailMetadata,
  triggerProjectDeployment,
  upsertEnvVariable
} from "./auth-boundary";

async function getRequestCookieHeader() {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function buildRequestOptions() {
  return { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader: undefined as string | undefined };
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

export async function loadRequestProjectDetailMetadata(projectId: string) {
  const cookieHeader = await getRequestCookieHeader();
  return loadProjectDetailMetadata(projectId, { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function createRequestProject(input: Parameters<typeof createProject>[0]) {
  const cookieHeader = await getRequestCookieHeader();
  return createProject(input, { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function triggerRequestProjectDeployment(projectId: string) {
  const cookieHeader = await getRequestCookieHeader();
  return triggerProjectDeployment(projectId, { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function upsertRequestEnvVariable(projectId: string, input: Parameters<typeof upsertEnvVariable>[1]) {
  const cookieHeader = await getRequestCookieHeader();
  return upsertEnvVariable(projectId, input, { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export async function deleteRequestProject(projectId: string) {
  const cookieHeader = await getRequestCookieHeader();
  return deleteProject(projectId, { apiBaseUrl: getAuthApiBaseUrl() ?? undefined, cookieHeader });
}

export { buildRequestOptions };
