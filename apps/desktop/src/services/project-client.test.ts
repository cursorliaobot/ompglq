import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

function wireProject(): Record<string, unknown> {
  return {
    id: 1,
    target_id: "local",
    canonical_path: "/work/example",
    display_path: "/work/example",
    git_identity: null,
    created_at_epoch_ms: 100,
    last_used_at_epoch_ms: 120,
    authorization_status: "active",
    binding: {
      id: 11,
      revision: 3,
      path_prefix: "/work/example",
      profile: "default",
      profile_source: "project",
      terminal_mode: "embedded",
      terminal_mode_source: "project",
      account_policy: "automatic",
      account_policy_source: "project",
      role_defaults: {},
      allowed_models: [],
      disabled_providers: [],
      updated_at_epoch_ms: 110,
    },
  };
}

function wireWorkspace(): Record<string, unknown> {
  return {
    projects: [wireProject()],
    known_profiles: [
      {
        name: "default",
        source: "default",
        agent_directory: null,
        is_complete_inventory: false,
      },
    ],
  };
}

describe("project client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
  });

  it("loads and decodes the workspace using the stable command name", async () => {
    mocks.invoke.mockResolvedValue(wireWorkspace());
    const client = await import("./project-client");

    const workspace = await client.getProjectWorkspace();

    expect(workspace.projects[0]?.binding.revision).toBe(3);
    expect(mocks.invoke).toHaveBeenCalledWith("project_workspace");
  });

  it("deduplicates only concurrent workspace reads and resets after settlement", async () => {
    mocks.invoke.mockResolvedValue(wireWorkspace());
    const client = await import("./project-client");

    const first = client.getProjectWorkspace();
    const second = client.getProjectWorkspace();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    await client.getProjectWorkspace();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("allows write-after-read refreshes to bypass an older workspace request", async () => {
    mocks.invoke.mockResolvedValue(wireWorkspace());
    const client = await import("./project-client");

    const older = client.getProjectWorkspace();
    const forced = client.getProjectWorkspace(true);

    expect(forced).not.toBe(older);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await Promise.all([older, forced]);
    await client.getProjectWorkspace();
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("clears the workspace single-flight after a rejection", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(wireWorkspace());
    const client = await import("./project-client");

    await expect(client.getProjectWorkspace()).rejects.toThrow("offline");
    await expect(client.getProjectWorkspace()).resolves.toMatchObject({ projects: [{ id: 1 }] });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("passes the bounded add request and decodes its result", async () => {
    mocks.invoke.mockResolvedValue({
      project: wireProject(),
      diagnostics: [
        {
          code: "project_added",
          message: "Added",
          suggestion: "",
          retryable: false,
          technical_detail_redacted: "",
        },
      ],
    });
    const client = await import("./project-client");

    const result = await client.addProject({
      profile: "default",
      terminal_mode: "embedded",
      account_policy: "automatic",
    });

    expect(result?.project.authorization_status).toBe("active");
    expect(mocks.invoke).toHaveBeenCalledWith("add_project", {
      request: {
        profile: "default",
        terminal_mode: "embedded",
        account_policy: "automatic",
      },
    });
  });

  it("treats a cancelled native directory selection as a successful null result", async () => {
    mocks.invoke.mockResolvedValue(null);
    const client = await import("./project-client");

    await expect(
      client.addProject({
        profile: "default",
        terminal_mode: "embedded",
        account_policy: "automatic",
      }),
    ).resolves.toBeNull();
  });

  it("does not merge concurrent writes", async () => {
    mocks.invoke.mockResolvedValue({ project: wireProject(), diagnostics: [] });
    const client = await import("./project-client");
    const request = {
      profile: "default",
      terminal_mode: "embedded",
      account_policy: "automatic",
    } as const;

    await Promise.all([client.addProject(request), client.addProject(request)]);

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("sends optimistic revision updates and decodes the returned project", async () => {
    const updated = wireProject();
    (updated.binding as Record<string, unknown>).revision = 4;
    mocks.invoke.mockResolvedValue(updated);
    const client = await import("./project-client");

    const project = await client.updateProjectBinding({
      project_id: 1,
      expected_revision: 3,
      profile: "work",
      terminal_mode: "embedded",
      account_policy: "profile",
    });

    expect(project.binding.revision).toBe(4);
    expect(mocks.invoke).toHaveBeenCalledWith("update_project_binding", {
      request: {
        project_id: 1,
        expected_revision: 3,
        profile: "work",
        terminal_mode: "embedded",
        account_policy: "profile",
      },
    });
  });

  it("opens Cursor using only project and fixed editor identifiers", async () => {
    mocks.invoke.mockResolvedValue({
      project_id: 1,
      editor_id: "cursor",
      process_id: 42,
    });
    const client = await import("./project-client");

    await expect(client.openProjectInCursor(1)).resolves.toEqual({
      project_id: 1,
      editor_id: "cursor",
      process_id: 42,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("open_project_in_editor", {
      request: {
        project_id: 1,
        editor_id: "cursor",
      },
    });
  });

  it("rejects malformed command responses instead of returning them to the UI", async () => {
    mocks.invoke.mockResolvedValue({ projects: [{ id: "one" }], known_profiles: [] });
    const client = await import("./project-client");

    await expect(client.getProjectWorkspace()).rejects.toMatchObject({
      name: "InvalidProjectPayloadError",
    });
  });
});
