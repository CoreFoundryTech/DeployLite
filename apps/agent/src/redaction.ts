import { redactSecrets } from "@deploylite/config";

const ENV_NEW_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}=/;
const REDACTED = "[REDACTED]";

/** Multiline-safe redactor shared by materialization, executor, and worker. */
export function redactEnvFileForLog(contents: string): string {
  const redacted: string[] = [];
  let redactingMultilineValue = false;

  for (const line of contents.split("\n")) {
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      redacted.push(redactingMultilineValue ? REDACTED : redactSecrets(line));
      continue;
    }
    if (equalsIndex > 0 && ENV_NEW_KEY_PATTERN.test(line)) {
      redacted.push(`${line.slice(0, equalsIndex)}=${REDACTED}`);
      redactingMultilineValue = line.slice(equalsIndex + 1).length > 0;
      continue;
    }
    redacted.push(redactingMultilineValue ? REDACTED : `${line.slice(0, equalsIndex)}=${REDACTED}`);
  }

  return redacted.join("\n");
}
