import { spawn as spawnChild } from "node:child_process";

const cleanPath = (env) => typeof env.PATH === "string" && env.PATH ? env.PATH : "/usr/bin:/bin";
const OUTPUT_LIMIT = 16_384;

export function sanitizedEnvironment(env = process.env) {
  return Object.freeze({ CI: "true", HOME: "/nonexistent", NO_COLOR: "1", PATH: cleanPath(env) });
}

export function spawnBounded({ command, args, cwd, env, timeoutMs, shell }) {
  return new Promise((resolve) => {
    const child = spawnChild(command, args, { cwd, env, shell, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk) => { output = `${output}${chunk}`.slice(0, OUTPUT_LIMIT); };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => { clearTimeout(timer); resolve({ event: "error", output }); });
    child.on("close", (exitCode) => { clearTimeout(timer); resolve(timedOut ? { event: "timeout", output } : { exitCode, output }); });
  });
}

export async function runCheck(check, { cwd, available, spawn = spawnBounded, env = process.env }) {
  const result = { ...check, exitCode: null, durationMs: 0, excerpt: "" };
  if (!available.has(check.capability)) return { ...result, outcome: "blocked", reasonCode: "missing_capability" };
  const started = Date.now();
  try {
    const process = await spawn({ command: check.argv[0], args: check.argv.slice(1), cwd, env: sanitizedEnvironment(env), timeoutMs: check.timeoutMs, shell: false });
    const durationMs = Date.now() - started;
    if (process.event === "timeout") return { ...result, outcome: "blocked", reasonCode: "timeout", durationMs, excerpt: process.output ?? "" };
    if (process.event === "error") return { ...result, outcome: "blocked", reasonCode: "execution_error", durationMs, excerpt: process.output ?? "" };
    return { ...result, outcome: process.exitCode === 0 ? "pass" : "fail", exitCode: process.exitCode ?? null, durationMs, excerpt: process.output ?? "" };
  } catch (error) {
    return { ...result, outcome: "blocked", reasonCode: "execution_error", durationMs: Date.now() - started, excerpt: error instanceof Error ? error.message : "execution error" };
  }
}
