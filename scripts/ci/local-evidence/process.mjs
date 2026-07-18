import { spawn as spawnChild } from "node:child_process";

const cleanPath = (env) => typeof env.PATH === "string" && env.PATH ? env.PATH : "/usr/bin:/bin";
const OUTPUT_LIMIT = 16_384;
const TERMINATION_GRACE_MS = 50;

export function sanitizedEnvironment(env = process.env) {
  return Object.freeze({ CI: "true", HOME: "/nonexistent", NO_COLOR: "1", PATH: cleanPath(env) });
}

export function spawnBounded({ command, args, cwd, env, timeoutMs, shell }) {
  return new Promise((resolve) => {
    const child = spawnChild(command, args, { cwd, env, shell, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk) => { output = `${output}${chunk}`.slice(0, OUTPUT_LIMIT); };
    let escalationTimer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      resolve(result);
    };
    const terminate = (signal) => {
      try { child.kill(signal); } catch { /* The child has already exited or cannot be signalled. */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      escalationTimer = setTimeout(() => {
        terminate("SIGKILL");
        settle({ event: "timeout", output });
      }, TERMINATION_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => settle({ event: "error", output }));
    child.on("close", (exitCode) => settle(timedOut ? { event: "timeout", output } : { exitCode, output }));
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
