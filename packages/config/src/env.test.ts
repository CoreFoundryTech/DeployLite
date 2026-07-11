import { describe, expect, it } from "vitest";
import { parseDeployLiteEnv } from "./env.js";

describe("agent transport environment", () => {
  it("accepts a UUID identity and a strong shared bearer token", () => {
    const parsed = parseDeployLiteEnv({
      DEPLOYLITE_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      DEPLOYLITE_AGENT_TOKEN: "agent-token-with-at-least-32-characters"
    });
    expect(parsed.DEPLOYLITE_AGENT_ID).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.DEPLOYLITE_AGENT_TOKEN).toBe("agent-token-with-at-least-32-characters");
  });

  it("rejects malformed identities and weak tokens", () => {
    expect(() => parseDeployLiteEnv({ DEPLOYLITE_AGENT_ID: "agent-1", DEPLOYLITE_AGENT_TOKEN: "short" })).toThrow();
    expect(() => parseDeployLiteEnv({ DEPLOYLITE_AGENT_TOKEN: "agent-token-with-at-least-32-characters" })).toThrow();
  });

  it("validates registry integrity keys while allowing an empty optional previous key", () => {
    expect(() => parseDeployLiteEnv({ DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY: "short" })).toThrow();
    const parsed = parseDeployLiteEnv({
      DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY: "registry-integrity-key-with-at-least-32-chars",
      DEPLOYLITE_AGENT_BUILDER_REGISTRY_PREVIOUS_INTEGRITY_KEY: ""
    });
    expect(parsed.DEPLOYLITE_AGENT_BUILDER_REGISTRY_PREVIOUS_INTEGRITY_KEY).toBeUndefined();
  });
});
