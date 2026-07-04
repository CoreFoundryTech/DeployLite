import { authResponseSchema, type AuthResponse, type SafeAuthUserDto } from "@deploylite/contracts";

export const authApiPaths = {
  login: "/api/v1/auth/login",
  me: "/api/v1/auth/me",
  logout: "/api/v1/auth/logout"
} as const;

export const defaultSessionCookieName = "deploylite_session";

export type AuthBoundaryReason = "missing-cookie" | "api-unconfigured" | "api-rejected" | "api-unreachable";

export type AuthBoundaryState =
  | { kind: "authenticated"; user: SafeAuthUserDto }
  | { kind: "unauthenticated"; reason: AuthBoundaryReason };

export type AuthApiRequestOptions = {
  method: "GET" | "POST";
  body?: unknown;
};

export type LoadAuthSessionOptions = {
  apiBaseUrl?: string;
  cookieHeader?: string;
  fetchImpl?: typeof fetch;
};

type ApiEnvelope<Data> = {
  data: Data | null;
  error: { code: string; message: string; correlationId: string } | null;
  requestId: string;
};

export function getAuthApiBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  return env.DEPLOYLITE_WEB_API_BASE_URL ?? env.NEXT_PUBLIC_DEPLOYLITE_API_URL ?? null;
}

export function createAuthApiUrl(path: (typeof authApiPaths)[keyof typeof authApiPaths], apiBaseUrl: string): string {
  return new URL(path, apiBaseUrl).toString();
}

export function createAuthApiRequest(options: AuthApiRequestOptions): RequestInit {
  return {
    method: options.method,
    credentials: "include",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  };
}

export function hasSessionCookie(cookieHeader: string | undefined, cookieName = defaultSessionCookieName): boolean {
  return (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .some((part) => part.startsWith(`${cookieName}=`) && part.slice(cookieName.length + 1).length > 0);
}

export function resolveAuthBoundary(user: SafeAuthUserDto | null, reason: AuthBoundaryReason = "missing-cookie"): AuthBoundaryState {
  return user ? { kind: "authenticated", user } : { kind: "unauthenticated", reason };
}

export async function loadAuthSession(options: LoadAuthSessionOptions): Promise<AuthBoundaryState> {
  if (!hasSessionCookie(options.cookieHeader)) {
    return resolveAuthBoundary(null, "missing-cookie");
  }

  if (!options.apiBaseUrl) {
    return resolveAuthBoundary(null, "api-unconfigured");
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(authApiPaths.me, options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "GET" }),
      headers: { cookie: options.cookieHeader ?? "" }
    });

    if (!response.ok) {
      return resolveAuthBoundary(null, "api-rejected");
    }

    const envelope = (await response.json()) as ApiEnvelope<AuthResponse>;
    const data = authResponseSchema.safeParse(envelope.data);
    return data.success ? resolveAuthBoundary(data.data.user) : resolveAuthBoundary(null, "api-rejected");
  } catch {
    return resolveAuthBoundary(null, "api-unreachable");
  }
}
