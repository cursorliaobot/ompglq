import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  decodeLaunchExecution,
  decodeLaunchOptions,
  decodePreparedLaunch,
  decodePtyOutputBatch,
  decodePtyOutputFrame,
  decodePtyRun,
  InvalidLaunchPayloadError,
  type LaunchExecutionResult,
  type LaunchOptions,
  type LaunchScope,
  type PrepareLaunchInput,
  type PreparedLaunchPlan,
  type PtyOutputBatch,
  type PtyOutputFrame,
  type PtyRunSnapshot,
} from "../domain/launch";

const PTY_OUTPUT_EVENT = "omp-manager-pty-output";
const PTY_STATUS_EVENT = "omp-manager-pty-status";
const currentOptionReads = new Map<string, Promise<LaunchOptions>>();

function validateScope(scope: LaunchScope): void {
  if (
    !Number.isSafeInteger(scope.projectId) ||
    scope.projectId < 1 ||
    !Number.isSafeInteger(scope.bindingRevision) ||
    scope.bindingRevision < 1 ||
    (scope.action === "new" && scope.sessionIndexId !== null) ||
    (scope.action === "resume" &&
      (scope.sessionIndexId === null ||
        !Number.isSafeInteger(scope.sessionIndexId) ||
        scope.sessionIndexId < 1))
  ) {
    throw new InvalidLaunchPayloadError("scope");
  }
}

function scopeKey(scope: LaunchScope): string {
  return `${scope.projectId}\u0000${scope.bindingRevision}\u0000${scope.action}\u0000${
    scope.sessionIndexId ?? ""
  }`;
}

function scopeRequest(scope: LaunchScope) {
  return {
    project_id: scope.projectId,
    expected_binding_revision: scope.bindingRevision,
    action: scope.action,
    session_index_id: scope.sessionIndexId,
  };
}

function validateRunId(runId: string): void {
  if (
    typeof runId !== "string" ||
    runId.length > 64 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)
  ) {
    throw new InvalidLaunchPayloadError("run_id");
  }
}

export function getLaunchOptions(scope: LaunchScope, force = false): Promise<LaunchOptions> {
  try {
    validateScope(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = scopeKey(scope);
  const current = currentOptionReads.get(key);
  if (!force && current !== undefined) {
    return current;
  }
  const request = invoke<unknown>("project_launch_options", {
    request: scopeRequest(scope),
  })
    .then((value) => decodeLaunchOptions(value, scope))
    .finally(() => {
      if (currentOptionReads.get(key) === request) {
        currentOptionReads.delete(key);
      }
    });
  currentOptionReads.set(key, request);
  return request;
}

export function prepareLaunch(input: PrepareLaunchInput): Promise<PreparedLaunchPlan> {
  try {
    validateScope(input);
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<unknown>("prepare_project_launch", {
    request: {
      ...scopeRequest(input),
      model_roles: input.modelRoles,
      thinking_level: input.thinkingLevel,
    },
  }).then((value) => decodePreparedLaunch(value, input));
}

export function executeLaunch(plan: PreparedLaunchPlan): Promise<LaunchExecutionResult> {
  return invoke<unknown>("execute_project_launch", {
    request: { plan_id: plan.plan_id },
  }).then((value) => decodeLaunchExecution(value, plan));
}

export function listPtyRuns(): Promise<readonly PtyRunSnapshot[]> {
  return invoke<unknown>("list_pty_runs").then((value) => {
    if (!Array.isArray(value) || value.length > 32) {
      throw new InvalidLaunchPayloadError("runs");
    }
    const runs = value.map((run) => decodePtyRun(run));
    if (new Set(runs.map((run) => run.run_id)).size !== runs.length) {
      throw new InvalidLaunchPayloadError("runs");
    }
    return runs;
  });
}

export function readPtyOutput(runId: string, afterSequence: number): Promise<PtyOutputBatch> {
  try {
    validateRunId(runId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new InvalidLaunchPayloadError("after_sequence");
    }
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<unknown>("read_pty_output", {
    request: { run_id: runId, after_sequence: afterSequence },
  }).then((value) => decodePtyOutputBatch(value, runId));
}

export function writePtyInput(runId: string, bytes: Uint8Array): Promise<void> {
  try {
    validateRunId(runId);
    if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1_024) {
      throw new InvalidLaunchPayloadError("input.bytes");
    }
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke("write_pty_input", {
    request: { run_id: runId, bytes: Array.from(bytes) },
  });
}

export function resizePty(
  runId: string,
  rows: number,
  cols: number,
  pixelWidth: number,
  pixelHeight: number,
): Promise<PtyRunSnapshot> {
  try {
    validateRunId(runId);
    for (const [field, value, minimum, maximum] of [
      ["rows", rows, 2, 500],
      ["cols", cols, 2, 500],
      ["pixel_width", pixelWidth, 0, 32_000],
      ["pixel_height", pixelHeight, 0, 32_000],
    ] as const) {
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new InvalidLaunchPayloadError(field);
      }
    }
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<unknown>("resize_pty", {
    request: {
      run_id: runId,
      rows,
      cols,
      pixel_width: pixelWidth,
      pixel_height: pixelHeight,
    },
  }).then((value) => decodePtyRun(value, runId));
}

export function terminatePty(runId: string, force: boolean): Promise<PtyRunSnapshot> {
  try {
    validateRunId(runId);
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<unknown>("terminate_pty", {
    request: { run_id: runId, force },
  }).then((value) => decodePtyRun(value, runId));
}

export function closePtyRun(runId: string): Promise<void> {
  try {
    validateRunId(runId);
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<void>("close_pty_run", {
    request: { run_id: runId },
  });
}

export interface PtyEventHandlers {
  readonly onOutput: (frame: PtyOutputFrame) => void;
  readonly onStatus: (run: PtyRunSnapshot) => void;
  readonly onInvalidPayload: () => void;
}

export interface PtyStatusHandlers {
  readonly onStatus: (run: PtyRunSnapshot) => void;
  readonly onInvalidPayload: () => void;
}

export function subscribeToPtyStatus(handlers: PtyStatusHandlers): Promise<UnlistenFn> {
  return listen<unknown>(PTY_STATUS_EVENT, (event) => {
    try {
      handlers.onStatus(decodePtyRun(event.payload));
    } catch {
      handlers.onInvalidPayload();
    }
  });
}

export async function subscribeToPty(
  runId: string,
  handlers: PtyEventHandlers,
): Promise<UnlistenFn> {
  validateRunId(runId);
  const unlistenOutput = await listen<unknown>(PTY_OUTPUT_EVENT, (event) => {
    try {
      const frame = decodePtyOutputFrame(event.payload, runId);
      handlers.onOutput(frame);
    } catch (error) {
      if (!(error instanceof InvalidLaunchPayloadError && error.message.endsWith("frame.run_id"))) {
        handlers.onInvalidPayload();
      }
    }
  });
  try {
    const unlistenStatus = await listen<unknown>(PTY_STATUS_EVENT, (event) => {
      try {
        handlers.onStatus(decodePtyRun(event.payload, runId));
      } catch (error) {
        if (!(error instanceof InvalidLaunchPayloadError && error.message.endsWith("run.run_id"))) {
          handlers.onInvalidPayload();
        }
      }
    });
    return () => {
      unlistenOutput();
      unlistenStatus();
    };
  } catch (error) {
    unlistenOutput();
    throw error;
  }
}
