import type { CorrelationContext } from "./ids.js";
import { createSafeProjection } from "./redaction.js";

export type AuditLogInput = CorrelationContext & {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
};

export type AuditLogRecord = AuditLogInput & {
  timestamp: string;
};

export function createAuditLogRecord(input: AuditLogInput, now = new Date()): AuditLogRecord {
  return createSafeProjection("log", { ...input, timestamp: now.toISOString() }) as AuditLogRecord;
}
