import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildApiApp } from "./app.js";

const defaultHost = "127.0.0.1";
const defaultPort = 3001;

function parsePort(value: string | undefined): number {
  if (!value) return defaultPort;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid API port: ${value}`);
  }
  return port;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint ? pathToFileURL(resolve(entrypoint)).href === import.meta.url : false;
}

export async function startApiServer(env: NodeJS.ProcessEnv = process.env) {
  const app = await buildApiApp({ env });
  const host = env.DEPLOYLITE_API_HOST ?? defaultHost;
  const port = parsePort(env.DEPLOYLITE_API_PORT ?? env.PORT);

  const close = async () => {
    await app.close();
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await app.listen({ host, port });
  return { app, host, port };
}

if (isMainModule()) {
  startApiServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { API_PREFIX, AUTH_HEADER, buildApiApp } from "./app.js";
