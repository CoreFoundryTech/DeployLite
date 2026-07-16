import { describe, expect, it } from "vitest";
import { admitControlPlaneRequest, parseDeployLiteEnv } from "./env.js";

const env = parseDeployLiteEnv({
  DEPLOYLITE_REPOSITORY_ALLOWLIST: "github.com",
  DEPLOYLITE_IMAGE_ALLOWLIST: "ghcr.io",
  DEPLOYLITE_ADMISSION_MAX_PAYLOAD_BYTES: "100",
  DEPLOYLITE_ADMISSION_MAX_RATE_PER_MINUTE: "2",
  DEPLOYLITE_ADMISSION_MAX_CONCURRENCY: "1",
  DEPLOYLITE_ADMISSION_MAX_CPU_CORES: "2",
  DEPLOYLITE_ADMISSION_MAX_MEMORY_MIB: "512"
});

describe("control-plane admission", () => {
  it("canonicalizes allowed references and admits a bounded request", () => {
    expect(admitControlPlaneRequest(env, {
      repositoryUrl: "HTTPS://GitHub.com/owner/repo.git",
      image: "ghcr.io/owner/app:v1",
      payloadBytes: 100,
      ratePerMinute: 2,
      concurrentCommands: 1,
      cpuCores: 2,
      memoryMiB: 512
    })).toEqual({ repositoryUrl: "https://github.com/owner/repo", image: "ghcr.io/owner/app:v1" });
  });

  it("rejects private repositories, mutable production images, and each exceeded limit deterministically", () => {
    const base = { repositoryUrl: "https://github.com/owner/repo", image: "ghcr.io/owner/app:latest", payloadBytes: 1, ratePerMinute: 1, concurrentCommands: 1, cpuCores: 1, memoryMiB: 1 };
    expect(() => admitControlPlaneRequest(env, { ...base, repositoryUrl: "http://127.0.0.1/repo" })).toThrow("REPOSITORY_DENIED");
    expect(() => admitControlPlaneRequest({ ...env, NODE_ENV: "production" }, base)).toThrow("IMAGE_MUTABLE_TAG");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", payloadBytes: 101 })).toThrow("PAYLOAD_LIMIT_EXCEEDED");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", ratePerMinute: 3 })).toThrow("RATE_LIMIT_EXCEEDED");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", concurrentCommands: 2 })).toThrow("CONCURRENCY_LIMIT_EXCEEDED");
    expect(() => admitControlPlaneRequest(env, { ...base, image: "ghcr.io/owner/app:v1", cpuCores: 3 })).toThrow("RESOURCE_LIMIT_EXCEEDED");
  });
});
