import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

function wireSnapshot(): Record<string, unknown> {
  return {
    project_id: 3,
    profile: "default",
    profile_inventory_complete: false,
    root_status: "active",
    last_scanned_at_epoch_ms: 1_000,
    sessions: [],
    diagnostics: [],
  };
}

function wirePreview(): Record<string, unknown> {
  return {
    project_id: 3,
    session_index_id: 9,
    profile: "default",
    session_id: "session-nine",
    title: "Preview",
    cwd_display: "/work/example",
    read_status: "readable",
    model_selector: null,
    provider: null,
    model_roles: {},
    last_model_role: null,
    thinking_level: null,
    credential_providers: [],
    message_count: 1,
    first_message_summary: "hello",
    messages: [{ role: "user", text: "hello", timestamp: null }],
    skipped_record_count: 0,
    warning_codes: [],
    source_modified_at_epoch_ms: 1_000,
    source_size_bytes: 512,
  };
}

const scope = {
  projectId: 3,
  profile: "default",
  bindingRevision: 2,
} as const;

describe("session client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
  });

  it("deduplicates only concurrent cached reads per project", async () => {
    mocks.invoke.mockResolvedValue(wireSnapshot());
    const client = await import("./session-client");

    const first = client.getProjectSessions(scope);
    const second = client.getProjectSessions(scope);
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("project_sessions", { projectId: 3 });

    await client.getProjectSessions(scope);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("allows a forced read to bypass an older request", async () => {
    mocks.invoke.mockResolvedValue(wireSnapshot());
    const client = await import("./session-client");

    const older = client.getProjectSessions(scope);
    const forced = client.getProjectSessions(scope, true);
    expect(forced).not.toBe(older);
    await Promise.all([older, forced]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("treats a cancelled native root picker as a successful null result", async () => {
    mocks.invoke.mockResolvedValue(null);
    const client = await import("./session-client");

    await expect(client.authorizeProjectSessions(scope)).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("authorize_project_sessions", {
      projectId: 3,
    });
  });

  it("decodes scan results and rejects a mismatched project scope", async () => {
    mocks.invoke.mockResolvedValueOnce(wireSnapshot()).mockResolvedValueOnce({
      ...wireSnapshot(),
      project_id: 4,
    });
    const client = await import("./session-client");

    await expect(client.scanProjectSessions(scope)).resolves.toMatchObject({
      project_id: 3,
      root_status: "active",
    });
    await expect(client.scanProjectSessions(scope)).rejects.toMatchObject({
      name: "InvalidSessionPayloadError",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("scan_project_sessions", {
      projectId: 3,
    });
  });

  it("rejects invalid identifiers before invoking native commands", async () => {
    const client = await import("./session-client");

    await expect(client.getProjectSessions({ ...scope, projectId: 0 })).rejects.toMatchObject({
      name: "InvalidSessionPayloadError",
    });
    await expect(
      client.authorizeProjectSessions({ ...scope, bindingRevision: Number.NaN }),
    ).rejects.toMatchObject({
      name: "InvalidSessionPayloadError",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("never deduplicates reads across Profile or binding-revision scopes", async () => {
    mocks.invoke.mockResolvedValue(wireSnapshot());
    const client = await import("./session-client");

    const current = client.getProjectSessions(scope);
    const newerRevision = client.getProjectSessions({
      ...scope,
      bindingRevision: 3,
    });
    const otherProfile = client.getProjectSessions({
      ...scope,
      profile: "work",
    });
    expect(newerRevision).not.toBe(current);
    expect(otherProfile).not.toBe(current);
    await expect(otherProfile).rejects.toMatchObject({
      name: "InvalidSessionPayloadError",
    });
    await Promise.all([current, newerRevision]);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("requests previews by opaque IDs and deduplicates only their exact scope", async () => {
    mocks.invoke.mockResolvedValue(wirePreview());
    const client = await import("./session-client");

    const first = client.previewProjectSession(scope, 9, "session-nine");
    const duplicate = client.previewProjectSession(scope, 9, "session-nine");
    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      session_index_id: 9,
      messages: [{ text: "hello" }],
    });
    expect(mocks.invoke).toHaveBeenCalledWith("preview_project_session", {
      request: {
        project_id: 3,
        session_index_id: 9,
      },
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched preview identities and invalid IDs", async () => {
    mocks.invoke.mockResolvedValue({ ...wirePreview(), session_id: "other" });
    const client = await import("./session-client");

    await expect(client.previewProjectSession(scope, 9, "session-nine")).rejects.toMatchObject({
      name: "InvalidSessionPayloadError",
    });
    await expect(client.previewProjectSession(scope, 0, "session-nine")).rejects.toMatchObject({
      name: "InvalidSessionPayloadError",
    });
  });
});
