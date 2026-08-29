import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function wireSnapshot(): Record<string, unknown> {
  return {
    operation: {
      operation_id: OPERATION_ID,
      kind: "omp_probe",
      target_id: "local",
      scope_kind: "omp_installation",
      scope_reference: "automatic_discovery",
      phase: "queued",
      status: "queued",
      revision: 1,
      cancellable: false,
      cancellation_requested: false,
      started_at_epoch_ms: 10,
      updated_at_epoch_ms: 10,
      finished_at_epoch_ms: null,
      history_persisted: false,
      persistence_diagnostic: null,
    },
    result: null,
    diagnostic: null,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("probe operation client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    vi.stubGlobal("window", { sessionStorage: memoryStorage() });
  });

  it("stores a newly started operation for WebView reload recovery", async () => {
    mocks.invoke.mockResolvedValue(wireSnapshot());
    const client = await import("./probe-client");

    const snapshot = await client.startNewOmpProbe();

    expect(snapshot.operation.operation_id).toBe(OPERATION_ID);
    expect(mocks.invoke).toHaveBeenCalledWith("start_omp_probe", {
      requestedPath: null,
    });
    expect(window.sessionStorage.getItem("omp-manager.omp-probe-operation-id")).toBe(OPERATION_ID);
  });

  it("resumes the stored operation without starting a duplicate", async () => {
    window.sessionStorage.setItem("omp-manager.omp-probe-operation-id", OPERATION_ID);
    mocks.invoke.mockResolvedValue(wireSnapshot());
    const client = await import("./probe-client");

    await client.resumeOrStartOmpProbe();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_omp_probe_operation", {
      operationId: OPERATION_ID,
    });
  });

  it("starts a replacement only when the stored operation is gone", async () => {
    window.sessionStorage.setItem("omp-manager.omp-probe-operation-id", OPERATION_ID);
    mocks.invoke.mockImplementation((command: string) =>
      command === "get_omp_probe_operation"
        ? Promise.reject({ code: "operation_not_found" })
        : Promise.resolve(wireSnapshot()),
    );
    const client = await import("./probe-client");

    await client.resumeOrStartOmpProbe();

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "get_omp_probe_operation", {
      operationId: OPERATION_ID,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "start_omp_probe", {
      requestedPath: null,
    });
  });

  it("deduplicates concurrent start requests in the WebView", async () => {
    mocks.invoke.mockResolvedValue(wireSnapshot());
    const client = await import("./probe-client");

    const [first, second] = await Promise.all([
      client.startNewOmpProbe(),
      client.startNewOmpProbe(),
    ]);

    expect(first.operation.operation_id).toBe(second.operation.operation_id);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
