import { describe, expect, it } from "vitest";

import type { ProjectSummary, ProjectWorkspace } from "../domain/project";
import { createProjectsState, reduceProjectsState } from "./project-state";

function project(
  id: number,
  options: {
    readonly lastUsed?: number;
    readonly profile?: string;
    readonly revision?: number;
  } = {},
): ProjectSummary {
  const profile = options.profile ?? "default";
  return {
    id,
    target_id: "local",
    canonical_path: `/work/project-${id}`,
    display_path: `/work/project-${id}`,
    git_identity: null,
    created_at_epoch_ms: 10,
    last_used_at_epoch_ms: options.lastUsed ?? 20,
    authorization_status: "active",
    binding: {
      id: id + 100,
      revision: options.revision ?? 1,
      path_prefix: `/work/project-${id}`,
      profile,
      profile_source: "project",
      terminal_mode: "embedded",
      terminal_mode_source: "project",
      account_policy: "automatic",
      account_policy_source: "project",
      role_defaults: {},
      allowed_models: [],
      disabled_providers: [],
      updated_at_epoch_ms: 15,
    },
  };
}

function workspace(projects: readonly ProjectSummary[]): ProjectWorkspace {
  return {
    projects,
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

describe("project state reducer", () => {
  it("gates loading while disabled and orders a loaded workspace by recent use", () => {
    const disabled = createProjectsState(false);
    expect(disabled.loadPhase).toBe("disabled");

    const loading = reduceProjectsState(disabled, { type: "load_started" });
    const ready = reduceProjectsState(loading, {
      type: "load_succeeded",
      workspace: workspace([project(1, { lastUsed: 30 }), project(2, { lastUsed: 50 })]),
    });

    expect(ready.loadPhase).toBe("ready");
    expect(ready.projects.map((item) => item.id)).toEqual([2, 1]);
  });

  it("upserts an added project and keeps its non-blocking diagnostics", () => {
    const ready = reduceProjectsState(createProjectsState(true), {
      type: "load_succeeded",
      workspace: workspace([project(1)]),
    });
    const adding = reduceProjectsState(ready, { type: "add_started" });
    const result = reduceProjectsState(adding, {
      type: "add_succeeded",
      result: {
        project: project(2, { profile: "work", lastUsed: 40 }),
        diagnostics: [
          {
            code: "git_identity_unavailable",
            message: "Git identity was not available",
            suggestion: "The project remains usable",
            retryable: false,
            technical_detail_redacted: "stage=git_identity",
          },
        ],
      },
    });

    expect(result.projects.map((item) => item.id)).toEqual([2, 1]);
    expect(result.knownProfiles).toContainEqual({
      name: "work",
      source: "project_binding",
      agent_directory: null,
      is_complete_inventory: false,
    });
    expect(result.addDiagnostics[0]?.code).toBe("git_identity_unavailable");
    expect(result.mutation.phase).toBe("idle");
  });

  it("replaces only the returned revision after a successful binding update", () => {
    const ready = reduceProjectsState(createProjectsState(true), {
      type: "load_succeeded",
      workspace: workspace([project(1), project(2)]),
    });
    const updating = reduceProjectsState(ready, { type: "update_started", projectId: 1 });
    const updated = reduceProjectsState(updating, {
      type: "update_succeeded",
      project: project(1, { profile: "work", revision: 2 }),
    });

    expect(updated.projects.find((item) => item.id === 1)?.binding).toMatchObject({
      profile: "work",
      revision: 2,
    });
    expect(updated.projects.find((item) => item.id === 2)?.binding.revision).toBe(1);
  });

  it("keeps the last good list when a revision conflict fails", () => {
    const ready = reduceProjectsState(createProjectsState(true), {
      type: "load_succeeded",
      workspace: workspace([project(1, { revision: 3 })]),
    });
    const failed = reduceProjectsState(ready, {
      type: "mutation_failed",
      action: "update",
      projectId: 1,
      failure: {
        kind: "backend",
        diagnostic: {
          code: "project_binding_revision_conflict",
          message: "Binding changed elsewhere",
          suggestion: "Reload projects",
          retryable: true,
          technical_detail_redacted: "expected_revision=2; actual_revision=3",
        },
      },
    });

    expect(failed.projects).toBe(ready.projects);
    expect(failed.projects[0]?.binding.revision).toBe(3);
    expect(failed.mutation).toMatchObject({
      phase: "failed",
      action: "update",
      projectId: 1,
    });
  });

  it("tracks fixed-editor launch feedback without changing the project list", () => {
    const ready = reduceProjectsState(createProjectsState(true), {
      type: "load_succeeded",
      workspace: workspace([project(1)]),
    });
    const opening = reduceProjectsState(ready, {
      type: "open_started",
      projectId: 1,
    });
    const opened = reduceProjectsState(opening, {
      type: "open_succeeded",
      projectId: 1,
    });

    expect(opening.mutation).toEqual({ phase: "opening", projectId: 1 });
    expect(opened.projects).toBe(ready.projects);
    expect(opened.mutation).toEqual({ phase: "idle" });
    expect(opened.editorOpenedProjectId).toBe(1);
  });

  it("clears transient mutation feedback without changing the workspace", () => {
    const state = reduceProjectsState(createProjectsState(true), {
      type: "load_succeeded",
      workspace: workspace([project(1)]),
    });
    const failed = reduceProjectsState(state, {
      type: "mutation_failed",
      action: "add",
      projectId: null,
      failure: { kind: "invoke_failed" },
    });
    const cleared = reduceProjectsState(failed, { type: "feedback_cleared" });

    expect(cleared.projects).toBe(state.projects);
    expect(cleared.mutation).toEqual({ phase: "idle" });
  });
});
