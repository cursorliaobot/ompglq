import { describe, expect, it } from "vitest";

import {
  classifyLaunchFailure,
  decodeLaunchOptions,
  decodePreparedLaunch,
  decodePtyOutputBatch,
  decodePtyRun,
  InvalidLaunchPayloadError,
} from "./launch";

const scope = {
  projectId: 7,
  bindingRevision: 3,
  action: "new",
  sessionIndexId: null,
} as const;

function shared() {
  return {
    project_id: 7,
    binding_revision: 3,
    action: "new",
    session_index_id: null,
    session_id: null,
    profile: "default",
    cwd_display: "/work/project",
    model_roles: { default: "synthetic/model" },
    thinking_level: "medium",
    credential_policy: { kind: "automatic" },
    terminal_mode: "embedded",
    warnings: [],
    setting_sources: { profile: "project", "model_roles.default": "project" },
  };
}

function run() {
  return {
    run_id: "123e4567-e89b-42d3-a456-426614174000",
    project_id: 7,
    action: "new",
    session_id: null,
    title: "Project",
    profile: "default",
    model_roles: { default: "synthetic/model" },
    thinking_level: "medium",
    status: "running",
    process_id: 42,
    started_at_epoch_ms: 1_000,
    finished_at_epoch_ms: null,
    exit_code: null,
    signal: null,
    rows: 30,
    cols: 120,
    first_available_sequence: 1,
    last_sequence: 1,
    output_truncated: false,
  };
}

describe("launch wire decoders", () => {
  it("decodes bounded options with exact model selectors", () => {
    const options = decodeLaunchOptions(
      {
        ...shared(),
        available_models: [
          {
            provider: "synthetic",
            id: "model",
            selector: "synthetic/model",
            name: "Synthetic",
            context_window: 100_000,
            max_tokens: 12_000,
            reasoning: true,
            thinking: ["low", "medium"],
            input: ["text"],
          },
        ],
      },
      scope,
    );

    expect(options.available_models[0]?.selector).toBe("synthetic/model");
    expect(options.model_roles.default).toBe("synthetic/model");
  });

  it("rejects a response from another binding scope", () => {
    expect(() =>
      decodeLaunchOptions(
        {
          ...shared(),
          binding_revision: 4,
          available_models: [],
        },
        scope,
      ),
    ).toThrow(InvalidLaunchPayloadError);
  });

  it("decodes a short-lived single-use plan", () => {
    const plan = decodePreparedLaunch(
      {
        ...shared(),
        plan_id: "123e4567-e89b-42d3-a456-426614174000",
        input_fingerprint: "0123456789abcdef",
        created_at_epoch_ms: 1_000,
        expires_at_epoch_ms: 121_000,
        display_preview_redacted: "omp --cwd [project]",
        environment: [{ name: "HOME", source: "manager_process", present: true }],
      },
      {
        ...scope,
        modelRoles: { default: "synthetic/model" },
        thinkingLevel: "medium",
      },
    );

    expect(plan.expires_at_epoch_ms - plan.created_at_epoch_ms).toBe(120_000);
  });

  it("validates PTY replay bytes and run identity", () => {
    const batch = decodePtyOutputBatch(
      {
        run: run(),
        frames: [
          {
            run_id: "123e4567-e89b-42d3-a456-426614174000",
            sequence: 1,
            bytes: [79, 77, 80],
          },
        ],
        gap_before_first_frame: false,
      },
      "123e4567-e89b-42d3-a456-426614174000",
    );

    expect(new TextDecoder().decode(batch.frames[0]?.bytes)).toBe("OMP");
    expect(decodePtyRun(run()).status).toBe("running");
  });

  it("rejects unusable run identifiers and contradictory terminal states", () => {
    expect(() => decodePtyRun({ ...run(), run_id: "not-a-uuid" })).toThrow(
      InvalidLaunchPayloadError,
    );
    expect(() => decodePtyRun({ ...run(), status: "exited" })).toThrow(InvalidLaunchPayloadError);
    expect(() =>
      decodePtyRun({
        ...run(),
        action: "resume",
        session_id: null,
      }),
    ).toThrow(InvalidLaunchPayloadError);
  });

  it("classifies exact backend diagnostics without trusting arbitrary objects", () => {
    expect(
      classifyLaunchFailure({
        code: "launch_plan_expired",
        message: "expired",
        suggestion: "retry",
        retryable: true,
        technical_detail_redacted: "",
      }),
    ).toMatchObject({ kind: "backend" });
    expect(classifyLaunchFailure({ message: "not a diagnostic" })).toEqual({
      kind: "invoke_failed",
    });
  });
});
