import { randomUUID } from "node:crypto";

export type CorrelationContext = {
  requestId: string;
  correlationId: string;
};

export function createRequestId(): string {
  return randomUUID();
}

export function createCorrelationContext(requestId = createRequestId()): CorrelationContext {
  return { requestId, correlationId: requestId };
}
