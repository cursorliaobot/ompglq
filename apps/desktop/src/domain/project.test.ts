import { describe, expect, it } from "vitest";

import {
  classifyProjectFailure,
  decodeAddProjectResult,
  decodeOpenProjectInEditorResult,
  decodeProjectSummary,
  decodeProjectWorkspace,
  InvalidProjectPayloadError,
} from "./project";

export function wireProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    target_id: "local",
    canonical_path: "/work/example",
    display_path: "/work/example",
    git_identity: {
      common_directory: "/work/example/.git",
      repository_relative_path: "",
    },
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
      role_defaults: { default: "openai/gpt-5" },
      allowed_models: ["openai/gpt-5"],
      disabled_providers: ["example-provider"],
      updated_at_epoch_ms: 110,
    },
    ...overrides,
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

function diagnostic(): Record<string, unknown> {
  return {
    code: "project_added",
    message: "Project added",
    suggestion: "",
    retryable: false,
    technical_detail_redacted: "",
  };
}

describe("project payload decoder", () => {
  it("accepts and preserves the complete snake_case workspace contract", () => {
    const workspace = decodeProjectWorkspace(wireWorkspace());

    expect(workspace.projects[0]).toMatchObject({
      id: 1,
      authorization_status: "active",
      binding: {
        revision: 3,
        terminal_mode: "embedded",
        account_policy: "automatic",
      },
    });
    expect(workspace.projects[0]?.git_identity?.repository_relative_path).toBe("");
    expect(workspace.known_profiles).toEqual([
      {
        name: "default",
        source: "default",
        agent_directory: null,
        is_complete_inventory: false,
      },
    ]);
  });

  it.each(["active", "offline", "replaced", "revoked", "missing"] as const)(
    "accepts the %s authorization state",
    (authorizationStatus) => {
      expect(
        decodeProjectSummary(wireProject({ authorization_status: authorizationStatus }))
          .authorization_status,
      ).toBe(authorizationStatus);
    },
  );

  it("sanitizes display-spoofing characters throughout nested backend text", () => {
    const project = wireProject({
      display_path: "/safe/\u202Ehidden",
      git_identity: {
        common_directory: "/safe/.git\u0007",
        repository_relative_path: "",
      },
    });
    const binding = project.binding as Record<string, unknown>;
    binding.role_defaults = { "default\u202E": "provider/model\u0007" };

    const result = decodeAddProjectResult({
      project,
      diagnostics: [
        {
          ...diagnostic(),
          message: "Added\u202Ehidden",
        },
      ],
    });

    expect(result.project.display_path).toBe("/safe/�hidden");
    expect(result.project.git_identity?.common_directory).toBe("/safe/.git�");
    expect(result.project.binding.role_defaults).toEqual({
      "default�": "provider/model�",
    });
    expect(result.diagnostics[0]?.message).toBe("Added�hidden");
  });

  it("rejects unknown finite enum values", () => {
    expect(() => decodeProjectSummary(wireProject({ authorization_status: "trusted" }))).toThrow(
      InvalidProjectPayloadError,
    );

    const project = wireProject();
    (project.binding as Record<string, unknown>).account_policy = "secret";
    expect(() => decodeProjectSummary(project)).toThrow(InvalidProjectPayloadError);
  });

  it("rejects non-positive revisions, unsafe ids, and inconsistent timestamps", () => {
    const noRevision = wireProject();
    (noRevision.binding as Record<string, unknown>).revision = 0;
    expect(() => decodeProjectSummary(noRevision)).toThrow(InvalidProjectPayloadError);

    expect(() => decodeProjectSummary(wireProject({ id: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(
      InvalidProjectPayloadError,
    );
    expect(() => decodeProjectSummary(wireProject({ created_at_epoch_ms: 121 }))).toThrow(
      InvalidProjectPayloadError,
    );
  });

  it("bounds top-level and nested collections and rejects ambiguous duplicates", () => {
    expect(() =>
      decodeProjectWorkspace({
        projects: Array.from({ length: 513 }, () => wireProject()),
        known_profiles: [],
      }),
    ).toThrow(InvalidProjectPayloadError);

    const tooManyRoles = wireProject();
    (tooManyRoles.binding as Record<string, unknown>).role_defaults = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`role-${index}`, `provider/model-${index}`]),
    );
    expect(() => decodeProjectSummary(tooManyRoles)).toThrow(InvalidProjectPayloadError);

    expect(() =>
      decodeProjectWorkspace({
        projects: [wireProject(), wireProject({ binding: wireProject().binding })],
        known_profiles: [],
      }),
    ).toThrow(InvalidProjectPayloadError);
  });

  it("rejects malformed nested collections and diagnostics", () => {
    const project = wireProject();
    (project.binding as Record<string, unknown>).allowed_models = ["openai/gpt-5", 7];
    expect(() => decodeProjectSummary(project)).toThrow(InvalidProjectPayloadError);

    expect(() =>
      decodeAddProjectResult({
        project: wireProject(),
        diagnostics: [{ ...diagnostic(), retryable: 1 }],
      }),
    ).toThrow(InvalidProjectPayloadError);
  });

  it("rejects a falsely complete known Profile inventory", () => {
    const workspace = wireWorkspace();
    const profiles = workspace.known_profiles as Array<Record<string, unknown>>;
    profiles[0]!.is_complete_inventory = true;

    expect(() => decodeProjectWorkspace(workspace)).toThrow(InvalidProjectPayloadError);
  });
});

describe("project editor result decoding", () => {
  it("accepts only the fixed Cursor result contract", () => {
    expect(
      decodeOpenProjectInEditorResult({
        project_id: 1,
        editor_id: "cursor",
        process_id: 42,
      }),
    ).toEqual({
      project_id: 1,
      editor_id: "cursor",
      process_id: 42,
    });
    expect(() =>
      decodeOpenProjectInEditorResult({
        project_id: 1,
        editor_id: "agent",
        process_id: null,
      }),
    ).toThrow(InvalidProjectPayloadError);
  });
});

describe("project failure classification", () => {
  it("distinguishes invalid responses from transport failures", () => {
    expect(classifyProjectFailure(new InvalidProjectPayloadError("root"))).toEqual({
      kind: "invalid_payload",
    });
    expect(classifyProjectFailure(new Error("WebView unavailable"))).toEqual({
      kind: "invoke_failed",
    });
  });

  it("accepts only a complete, typed backend diagnostic and sanitizes its text", () => {
    expect(
      classifyProjectFailure({
        ...diagnostic(),
        code: "binding_conflict",
        message: "Changed\u202Eelsewhere",
        suggestion: "Reload",
        retryable: true,
      }),
    ).toEqual({
      kind: "backend",
      diagnostic: {
        code: "binding_conflict",
        message: "Changed�elsewhere",
        suggestion: "Reload",
        retryable: true,
        technical_detail_redacted: "",
      },
    });
    expect(classifyProjectFailure({ ...diagnostic(), retryable: "yes" })).toEqual({
      kind: "invoke_failed",
    });
    expect(classifyProjectFailure({ ...diagnostic(), unexpected: true })).toEqual({
      kind: "invoke_failed",
    });
  });
});
