const secret = /\b(?:token|secret|password|authorization|api[-_]?key|credential)\b\s*([=:])\s*[^\s]+/gi;
const credential = /\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|AKIA[0-9A-Z]{16})\b/gi;
const path = /(?:\/(?:Users|home)\/[^\s]+|[A-Z]:\\Users\\[^\s]+)/g;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactOutput(output, { knownValues = [], canary = "", limit = 1600 } = {}) {
  if (typeof output !== "string") return Object.freeze({ safe: false, excerpt: "", redactions: 0, truncated: false, reasonCode: "unsafe_output" });
  let redactions = 0;
  let value = output.replace(secret, (_, separator) => { redactions += 1; return `redacted${separator}[REDACTED]`; })
    .replace(credential, () => { redactions += 1; return "[REDACTED]"; }).replace(path, () => { redactions += 1; return "[REDACTED_PATH]"; });
  for (const known of [...knownValues, canary].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replace(new RegExp(escape(known), "g"), () => { redactions += 1; return "[REDACTED]"; });
  if ([...knownValues, canary].filter(Boolean).some((known) => value.toLowerCase().includes(known.toLowerCase()))) return Object.freeze({ safe: false, excerpt: "", redactions, truncated: false, reasonCode: "unsafe_output" });
  return Object.freeze({ safe: true, excerpt: value.slice(0, limit), redactions, truncated: value.length > limit });
}
