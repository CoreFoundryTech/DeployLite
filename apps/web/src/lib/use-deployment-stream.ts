"use client";

import { useEffect, useRef, useState } from "react";
import type { LogEvent } from "@deploylite/contracts";

const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);

export type DeploymentStreamState = "connecting" | "connected" | "reconnecting" | "stopped" | "unauthorized" | "unavailable";

export type DeploymentStreamOptions = {
  deploymentId: string;
  apiBaseUrl: string | null;
  initialEvents?: LogEvent[];
  fetchImpl?: typeof fetch;
};

export type DeploymentStreamSnapshot = { events: LogEvent[]; state: DeploymentStreamState };

export function useDeploymentStream(options: DeploymentStreamOptions): DeploymentStreamSnapshot {
  const [snapshot, setSnapshot] = useState<DeploymentStreamSnapshot>({ events: options.initialEvents ?? [], state: "connecting" });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const stream = new DeploymentStreamController(optionsRef.current, setSnapshot);
    stream.start();
    return () => stream.stop();
  }, [options.deploymentId, options.apiBaseUrl]);

  return snapshot;
}

export class DeploymentStreamController {
  #events: LogEvent[];
  #state: DeploymentStreamState = "connecting";
  #controller: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #stopped = false;

  constructor(
    private readonly options: DeploymentStreamOptions,
    private readonly publish: (snapshot: DeploymentStreamSnapshot) => void,
    private readonly maxAttempts = 3
  ) {
    this.#events = [...(options.initialEvents ?? [])].sort((left, right) => left.sequence - right.sequence);
  }

  start() {
    if (!this.options.apiBaseUrl) return this.update("unavailable");
    void this.connect();
  }

  stop() {
    this.#stopped = true;
    this.#controller?.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  private update(state: DeploymentStreamState) {
    this.#state = state;
    this.publish({ events: this.#events, state });
  }

  private async connect() {
    if (this.#stopped || !this.options.apiBaseUrl) return;
    this.update(this.#attempt === 0 ? "connecting" : "reconnecting");
    this.#controller = new AbortController();
    try {
      const lastEventId = this.lastEventId();
      const response = await (this.options.fetchImpl ?? fetch)(
        new URL(`/api/v1/deployments/${encodeURIComponent(this.options.deploymentId)}/logs/stream`, this.options.apiBaseUrl),
        { credentials: "include", headers: lastEventId ? { "Last-Event-ID": lastEventId } : undefined, signal: this.#controller.signal }
      );
      if (this.#stopped) return;
      if (response.status === 401 || response.status === 403) return this.update("unauthorized");
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      this.update("connected");
      const text = await response.text();
      const terminal = this.consume(text);
      if (terminal === "unavailable") return this.update("unavailable");
      if (terminal) return this.update("stopped");
      this.reconnect();
    } catch (error) {
      if (!this.#stopped && !(error instanceof DOMException && error.name === "AbortError")) this.reconnect();
    }
  }

  private reconnect() {
    if (this.#stopped || this.#attempt >= this.maxAttempts) return this.update("unavailable");
    const delay = Math.min(250 * 2 ** this.#attempt++, 2_000);
    this.update("reconnecting");
    this.#timer = setTimeout(() => void this.connect(), delay);
  }

  private lastEventId(): string | null {
    const event = this.#events.at(-1);
    return event ? String(event.sequence) : null;
  }

  private consume(text: string): boolean | "unavailable" {
    let terminal: boolean | "unavailable" = false;
    for (const frame of text.split("\n\n")) {
      const id = /^id:\s*(\d+)$/m.exec(frame)?.[1];
      const type = /^event:\s*(.+)$/m.exec(frame)?.[1];
      const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if ((type === "deployment.status" || type === "deployment.terminal") && parsed.status === "unavailable") terminal = "unavailable";
        if ((type === "deployment.status" || type === "deployment.terminal") && typeof parsed.status === "string" && terminalStatuses.has(parsed.status)) terminal = true;
        if (type === "deployment.log" && parsed.redactionApplied === true && typeof parsed.sequence === "number" && !this.#events.some((item) => item.sequence === parsed.sequence)) {
          this.#events = [...this.#events, { ...parsed, sequence: parsed.sequence, id: typeof parsed.id === "string" ? parsed.id : id ?? String(parsed.sequence) } as LogEvent]
            .sort((left, right) => left.sequence - right.sequence);
          this.#attempt = 0;
          this.publish({ events: this.#events, state: this.#state });
        }
      } catch {
        // Malformed frames are ignored; only the API's safe log envelope is rendered.
      }
    }
    return terminal;
  }
}
