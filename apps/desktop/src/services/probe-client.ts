import { invoke } from "@tauri-apps/api/core";

import { decodeOmpProbeOperation, type OmpProbeOperationSnapshot } from "../domain/operation";

const OPERATION_STORAGE_KEY = "omp-manager.omp-probe-operation-id";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let currentStart: Promise<OmpProbeOperationSnapshot> | null = null;
let currentResume: Promise<OmpProbeOperationSnapshot> | null = null;

function readStoredOperationId(): string | null {
  try {
    const value = window.sessionStorage.getItem(OPERATION_STORAGE_KEY);
    return value !== null && UUID_V4.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeOperationId(operationId: string | null): void {
  try {
    if (operationId === null) {
      window.sessionStorage.removeItem(OPERATION_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(OPERATION_STORAGE_KEY, operationId);
    }
  } catch {
    // The backend still deduplicates active probes when storage is unavailable.
  }
}

function backendErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

export function getOmpProbeOperation(operationId: string): Promise<OmpProbeOperationSnapshot> {
  if (!UUID_V4.test(operationId)) {
    return Promise.reject(new Error("Invalid operation id"));
  }
  return invoke<unknown>("get_omp_probe_operation", { operationId }).then(decodeOmpProbeOperation);
}

export function startNewOmpProbe(): Promise<OmpProbeOperationSnapshot> {
  if (currentStart !== null) {
    return currentStart;
  }

  storeOperationId(null);
  currentStart = invoke<unknown>("start_omp_probe", { requestedPath: null })
    .then(decodeOmpProbeOperation)
    .then((snapshot) => {
      storeOperationId(snapshot.operation.operation_id);
      return snapshot;
    })
    .finally(() => {
      currentStart = null;
    });
  return currentStart;
}

export function resumeOrStartOmpProbe(): Promise<OmpProbeOperationSnapshot> {
  if (currentResume !== null) {
    return currentResume;
  }

  currentResume = (async () => {
    const operationId = readStoredOperationId();
    if (operationId !== null) {
      try {
        return await getOmpProbeOperation(operationId);
      } catch (error) {
        const code = backendErrorCode(error);
        if (code !== "operation_not_found" && code !== "operation_id_invalid") {
          throw error;
        }
        storeOperationId(null);
      }
    }
    return startNewOmpProbe();
  })().finally(() => {
    currentResume = null;
  });
  return currentResume;
}
