import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

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
    model_roles: {},
    thinking_level: null,
    credential_policy: { kind: "automatic" },
    terminal_mode: "embedded",
    warnings: [],
    setting_sources: { profile: "project" },
  } as const;
}

function plan() {
  return {
    ...shared(),
    model_roles: { default: "synthetic/model" },
    thinking_level: "medium",
    plan_id: "123e4567-e89b-42d3-a456-426614174000",
    input_fingerprint: "0123456789abcdef",
    created_at_epoch_ms: 1_000,
    expires_at_epoch_ms: 121_000,
    display_preview_redacted: "omp --cwd [project]",
    environment: [{ name: "HOME", source: "manager_process", present: true }],
  } as const;
}

function run() {
  return {
    run_id: "123e4567-e89b-42d3-a456-426614174001",
    project_id: 7,
    action: "new",
    session_id: null,
    title: "Project",
    profile: "default",
    model_roles: { default: "synthetic/model" },
    thinking_level: "medium",
    status: "running",
    process_id: 42,
    started_at_epoch_ms: 1_001,
    finished_at_epoch_ms: null,
    exit_code: null,
    signal: null,
    rows: 30,
    cols: 120,
    first_available_sequence: 1,
    last_sequence: 0,
    output_truncated: false,
  };
}

describe("launch client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("deduplicates concurrent launch-option reads only within one scope", async () => {
    mocks.invoke.mockResolvedValue({ ...shared(), available_models: [] });
    const client = await import("./launch-client");

    const first = client.getLaunchOptions(scope);
    const second = client.getLaunchOptions(scope);
    expect(first).toBe(second);
    await first;
    expect(mocks.invoke).toHaveBeenCalledWith("project_launch_options", {
      request: {
        project_id: 7,
        expected_binding_revision: 3,
        action: "new",
        session_index_id: null,
      },
    });

    mocks.invoke.mockResolvedValue({
      ...shared(),
      binding_revision: 4,
      available_models: [],
    });
    await client.getLaunchOptions({ ...scope, bindingRevision: 4 });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("sends structured plan input and verifies the returned PTY scope", async () => {
    mocks.invoke
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce({ kind: "embedded", run: run() });
    const client = await import("./launch-client");

    const prepared = await client.prepareLaunch({
      ...scope,
      modelRoles: { default: "synthetic/model" },
      thinkingLevel: "medium",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "prepare_project_launch", {
      request: {
        project_id: 7,
        expected_binding_revision: 3,
        action: "new",
        session_index_id: null,
        model_roles: { default: "synthetic/model" },
        thinking_level: "medium",
      },
    });

    await expect(client.executeLaunch(prepared)).resolves.toMatchObject({
      kind: "embedded",
      run: {
        run_id: "123e4567-e89b-42d3-a456-426614174001",
        project_id: 7,
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "execute_project_launch", {
      request: { plan_id: prepared.plan_id },
    });
  });

  it("rejects an execution result whose immutable model context changed", async () => {
    mocks.invoke.mockResolvedValueOnce({
      kind: "embedded",
      run: {
        ...run(),
        model_roles: { default: "other/model" },
      },
    });
    const client = await import("./launch-client");
    const prepared = { ...plan(), credential_policy: "automatic" as const };

    await expect(client.executeLaunch(prepared)).rejects.toThrow("execution.run.scope");
  });

  it("decodes a detached external-terminal launch without creating a PTY run", async () => {
    mocks.invoke.mockResolvedValueOnce({
      kind: "external",
      launch: {
        terminal_id: "xfce4-terminal",
        process_id: 42,
        project_id: 7,
        action: "new",
        session_id: null,
        profile: "default",
        model_roles: { default: "synthetic/model" },
        thinking_level: "medium",
        launched_at_epoch_ms: 1_001,
      },
    });
    const client = await import("./launch-client");
    const prepared = {
      ...plan(),
      credential_policy: "automatic" as const,
      terminal_mode: "external" as const,
    };

    await expect(client.executeLaunch(prepared)).resolves.toMatchObject({
      kind: "external",
      launch: {
        terminal_id: "xfce4-terminal",
        process_id: 42,
      },
    });
  });

  it("encodes terminal input as bounded byte arrays and decodes replay", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      run: { ...run(), last_sequence: 1 },
      frames: [
        {
          run_id: "123e4567-e89b-42d3-a456-426614174001",
          sequence: 1,
          bytes: [104, 105],
        },
      ],
      gap_before_first_frame: false,
    });
    const client = await import("./launch-client");
    const runId = "123e4567-e89b-42d3-a456-426614174001";

    await client.writePtyInput(runId, new TextEncoder().encode("hi"));
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "write_pty_input", {
      request: { run_id: runId, bytes: [104, 105] },
    });
    const replay = await client.readPtyOutput(runId, 0);
    expect(new TextDecoder().decode(replay.frames[0]?.bytes)).toBe("hi");
  });

  it("closes a completed run through the bounded run-id command", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);
    const client = await import("./launch-client");
    const runId = "123e4567-e89b-42d3-a456-426614174001";

    await client.closePtyRun(runId);

    expect(mocks.invoke).toHaveBeenCalledWith("close_pty_run", {
      request: { run_id: runId },
    });
  });

  it("subscribes globally to run status for WebView launch recovery", async () => {
    const unlisten = vi.fn();
    const onStatus = vi.fn();
    const onInvalidPayload = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const client = await import("./launch-client");

    const stop = await client.subscribeToPtyStatus({ onStatus, onInvalidPayload });
    const listener = mocks.listen.mock.calls[0]?.[1] as
      ((event: { payload: unknown }) => void) | undefined;
    listener?.({ payload: run() });

    expect(mocks.listen).toHaveBeenCalledWith("omp-manager-pty-status", expect.any(Function));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ run_id: run().run_id }));
    expect(onInvalidPayload).not.toHaveBeenCalled();
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
