import {
  decodeProbeReport,
  sanitizeWireText,
  type ProbeDiagnostic,
  type ProbeReport,
} from "./probe";

export const operationStatuses = [
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "timed_out",
  "needs_reconciliation",
] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export interface OperationSnapshot {
  readonly operation_id: string;
  readonly kind: "omp_probe";
  readonly target_id: string;
  readonly scope_kind: string;
  readonly scope_reference: string;
  readonly phase: string;
  readonly status: OperationStatus;
  readonly revision: number;
  readonly cancellable: boolean;
  readonly cancellation_requested: boolean;
  readonly started_at_epoch_ms: number;
  readonly updated_at_epoch_ms: number;
  readonly finished_at_epoch_ms: number | null;
  readonly history_persisted: boolean;
  readonly persistence_diagnostic: ProbeDiagnostic | null;
}

export interface OmpProbeOperationSnapshot {
  readonly operation: OperationSnapshot;
  readonly result: ProbeReport | null;
  readonly diagnostic: ProbeDiagnostic | null;
}

export class InvalidOperationPayloadError extends Error {
  public constructor(field: string) {
    super(`Invalid operation payload field: ${field}`);
    this.name = "InvalidOperationPayloadError";
  }
}

export function isTerminalOperation(status: OperationStatus): boolean {
  return (
    status === "cancelled" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "needs_reconciliation"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(record: Record<string, unknown>, field: string, maximumLength = 2_000): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new InvalidOperationPayloadError(field);
  }
  const text = sanitizeWireText(value, maximumLength);
  if (text.trim().length === 0) {
    throw new InvalidOperationPayloadError(field);
  }
  return text;
}

function readBoolean(record: Record<string, unknown>, field: string): boolean {
  if (typeof record[field] !== "boolean") {
    throw new InvalidOperationPayloadError(field);
  }
  return record[field];
}

function readInteger(record: Record<string, unknown>, field: string, minimum = 0): number {
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 8_640_000_000_000_000
  ) {
    throw new InvalidOperationPayloadError(field);
  }
  return value;
}

function readNullableInteger(record: Record<string, unknown>, field: string): number | null {
  return record[field] === null ? null : readInteger(record, field);
}

function readDiagnostic(value: unknown, field: string): ProbeDiagnostic | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new InvalidOperationPayloadError(field);
  }
  return {
    code: readText(value, "code", 160),
    message: readText(value, "message"),
    suggestion:
      typeof value.suggestion === "string"
        ? sanitizeWireText(value.suggestion)
        : (() => {
            throw new InvalidOperationPayloadError(`${field}.suggestion`);
          })(),
    retryable: readBoolean(value, "retryable"),
    technical_detail_redacted:
      typeof value.technical_detail_redacted === "string"
        ? sanitizeWireText(value.technical_detail_redacted, 4_000)
        : (() => {
            throw new InvalidOperationPayloadError(`${field}.technical_detail_redacted`);
          })(),
  };
}

function decodeOperation(value: unknown): OperationSnapshot {
  if (!isRecord(value)) {
    throw new InvalidOperationPayloadError("operation");
  }
  const operationId = readText(value, "operation_id", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
    throw new InvalidOperationPayloadError("operation.operation_id");
  }
  if (value.kind !== "omp_probe") {
    throw new InvalidOperationPayloadError("operation.kind");
  }
  const status = value.status;
  if (typeof status !== "string" || !operationStatuses.includes(status as OperationStatus)) {
    throw new InvalidOperationPayloadError("operation.status");
  }

  const operation: OperationSnapshot = {
    operation_id: operationId,
    kind: "omp_probe",
    target_id: readText(value, "target_id", 160),
    scope_kind: readText(value, "scope_kind", 160),
    scope_reference: readText(value, "scope_reference", 4_096),
    phase: readText(value, "phase", 160),
    status: status as OperationStatus,
    revision: readInteger(value, "revision", 1),
    cancellable: readBoolean(value, "cancellable"),
    cancellation_requested: readBoolean(value, "cancellation_requested"),
    started_at_epoch_ms: readInteger(value, "started_at_epoch_ms"),
    updated_at_epoch_ms: readInteger(value, "updated_at_epoch_ms"),
    finished_at_epoch_ms: readNullableInteger(value, "finished_at_epoch_ms"),
    history_persisted: readBoolean(value, "history_persisted"),
    persistence_diagnostic: readDiagnostic(
      value.persistence_diagnostic,
      "operation.persistence_diagnostic",
    ),
  };

  if (
    operation.updated_at_epoch_ms < operation.started_at_epoch_ms ||
    (isTerminalOperation(operation.status)
      ? operation.finished_at_epoch_ms === null
      : operation.finished_at_epoch_ms !== null) ||
    (operation.finished_at_epoch_ms !== null &&
      operation.finished_at_epoch_ms < operation.updated_at_epoch_ms) ||
    (!operation.cancellable && operation.cancellation_requested) ||
    (operation.history_persisted && operation.persistence_diagnostic !== null)
  ) {
    throw new InvalidOperationPayloadError("operation.invariants");
  }
  return operation;
}

export function decodeOmpProbeOperation(value: unknown): OmpProbeOperationSnapshot {
  if (!isRecord(value)) {
    throw new InvalidOperationPayloadError("root");
  }
  const operation = decodeOperation(value.operation);
  const result = value.result === null ? null : decodeProbeReport(value.result);
  const diagnostic = readDiagnostic(value.diagnostic, "diagnostic");

  if (
    (operation.status === "succeeded" && (result === null || diagnostic !== null)) ||
    ((operation.status === "failed" ||
      operation.status === "timed_out" ||
      operation.status === "cancelled" ||
      operation.status === "needs_reconciliation") &&
      (result !== null || diagnostic === null)) ||
    (!isTerminalOperation(operation.status) && (result !== null || diagnostic !== null))
  ) {
    throw new InvalidOperationPayloadError("result_invariants");
  }

  return { operation, result, diagnostic };
}
