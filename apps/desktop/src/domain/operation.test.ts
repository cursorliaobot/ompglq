import { describe, expect, it } from "vitest";

import {
  decodeOmpProbeOperation,
  InvalidOperationPayloadError,
  isTerminalOperation,
} from "./operation";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function probeReport(): Record<string, unknown> {
  return {
    target_id: "local",
    status: "ready",
    installation: {
      executable_path: "/usr/bin/omp",
      version: "1.0.0",
      architecture: "x86_64",
      probed_at_epoch_ms: 10,
      binary_modified_at_epoch_ms: null,
    },
    capabilities: [],
    diagnostics: [],
  };
}

function operation(status = "running"): Record<string, unknown> {
  const terminal = [
    "cancelled",
    "succeeded",
    "failed",
    "timed_out",
    "needs_reconciliation",
  ].includes(status);
  return {
    operation_id: OPERATION_ID,
    kind: "omp_probe",
    target_id: "local",
    scope_kind: "omp_installation",
    scope_reference: "automatic_discovery",
    phase: status === "running" ? "probing" : status,
    status,
    revision: 2,
    cancellable: false,
    cancellation_requested: false,
    started_at_epoch_ms: 10,
    updated_at_epoch_ms: 12,
    finished_at_epoch_ms: terminal ? 12 : null,
    history_persisted: false,
    persistence_diagnostic: null,
  };
}

function snapshot(status = "running"): Record<string, unknown> {
  return {
    operation: operation(status),
    result: status === "succeeded" ? probeReport() : null,
    diagnostic:
      status === "failed" || status === "timed_out"
        ? {
            code: "probe_failed",
            message: "Probe failed",
            suggestion: "Retry",
            retryable: true,
            technical_detail_redacted: "stage=probe",
          }
        : null,
  };
}

describe("OMP probe operation decoder", () => {
  it("accepts running and successful operation snapshots", () => {
    expect(decodeOmpProbeOperation(snapshot()).operation.status).toBe("running");
    expect(decodeOmpProbeOperation(snapshot("succeeded")).result?.status).toBe("ready");
  });

  it("sanitizes untrusted scope and diagnostic text", () => {
    const value = snapshot("failed");
    const wireOperation = value.operation as Record<string, unknown>;
    const diagnostic = value.diagnostic as Record<string, unknown>;
    wireOperation.scope_reference = "safe\u202Ehidden";
    diagnostic.message = "<script>\u0007";

    const decoded = decodeOmpProbeOperation(value);
    expect(decoded.operation.scope_reference).toBe("safe�hidden");
    expect(decoded.diagnostic?.message).toBe("<script>�");
  });

  it("rejects a terminal snapshot without a finish time", () => {
    const value = snapshot("succeeded");
    const wireOperation = value.operation as Record<string, unknown>;
    wireOperation.finished_at_epoch_ms = null;
    expect(() => decodeOmpProbeOperation(value)).toThrow(InvalidOperationPayloadError);
  });

  it("rejects success without a probe result", () => {
    const value = snapshot("succeeded");
    value.result = null;
    expect(() => decodeOmpProbeOperation(value)).toThrow(InvalidOperationPayloadError);
  });

  it("rejects noncanonical operation ids and unknown statuses", () => {
    const invalidId = snapshot();
    (invalidId.operation as Record<string, unknown>).operation_id = "../operation";
    expect(() => decodeOmpProbeOperation(invalidId)).toThrow(InvalidOperationPayloadError);

    const invalidStatus = snapshot();
    (invalidStatus.operation as Record<string, unknown>).status = "unknown";
    expect(() => decodeOmpProbeOperation(invalidStatus)).toThrow(InvalidOperationPayloadError);
  });

  it("recognizes only terminal lifecycle states", () => {
    expect(isTerminalOperation("running")).toBe(false);
    expect(isTerminalOperation("succeeded")).toBe(true);
    expect(isTerminalOperation("needs_reconciliation")).toBe(true);
  });
});
