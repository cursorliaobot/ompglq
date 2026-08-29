import type {
  AddProjectResult,
  KnownProfile,
  ProjectFailure,
  ProjectSummary,
  ProjectWorkspace,
} from "../domain/project";
import type { ProbeDiagnostic } from "../domain/probe";

export type ProjectLoadPhase = "disabled" | "loading" | "ready" | "failed";

export type ProjectMutationState =
  | { readonly phase: "idle" }
  | { readonly phase: "adding" }
  | { readonly phase: "updating"; readonly projectId: number }
  | { readonly phase: "opening"; readonly projectId: number }
  | {
      readonly phase: "failed";
      readonly action: "add" | "update" | "open";
      readonly projectId: number | null;
      readonly failure: ProjectFailure;
    };

export interface ProjectsState {
  readonly loadPhase: ProjectLoadPhase;
  readonly projects: readonly ProjectSummary[];
  readonly knownProfiles: readonly KnownProfile[];
  readonly loadFailure: ProjectFailure | null;
  readonly mutation: ProjectMutationState;
  readonly addDiagnostics: readonly ProbeDiagnostic[];
  readonly editorOpenedProjectId: number | null;
}

export type ProjectsStateEvent =
  | { readonly type: "disabled" }
  | { readonly type: "load_started" }
  | { readonly type: "load_succeeded"; readonly workspace: ProjectWorkspace }
  | { readonly type: "load_failed"; readonly failure: ProjectFailure }
  | { readonly type: "add_started" }
  | { readonly type: "add_cancelled" }
  | { readonly type: "add_succeeded"; readonly result: AddProjectResult }
  | { readonly type: "update_started"; readonly projectId: number }
  | { readonly type: "update_succeeded"; readonly project: ProjectSummary }
  | { readonly type: "open_started"; readonly projectId: number }
  | { readonly type: "open_succeeded"; readonly projectId: number }
  | {
      readonly type: "mutation_failed";
      readonly action: "add" | "update" | "open";
      readonly projectId: number | null;
      readonly failure: ProjectFailure;
    }
  | { readonly type: "feedback_cleared" };

export function createProjectsState(enabled: boolean): ProjectsState {
  return {
    loadPhase: enabled ? "loading" : "disabled",
    projects: [],
    knownProfiles: [],
    loadFailure: null,
    mutation: { phase: "idle" },
    addDiagnostics: [],
    editorOpenedProjectId: null,
  };
}

function sortProjects(projects: readonly ProjectSummary[]): readonly ProjectSummary[] {
  return [...projects].sort(
    (left, right) => right.last_used_at_epoch_ms - left.last_used_at_epoch_ms || left.id - right.id,
  );
}

function upsertProject(
  projects: readonly ProjectSummary[],
  project: ProjectSummary,
): readonly ProjectSummary[] {
  const withoutProject = projects.filter((candidate) => candidate.id !== project.id);
  return sortProjects([...withoutProject, project]);
}

function includeProjectProfile(
  profiles: readonly KnownProfile[],
  project: ProjectSummary,
): readonly KnownProfile[] {
  if (profiles.some((profile) => profile.name === project.binding.profile)) {
    return profiles;
  }

  const projectProfile: KnownProfile = {
    name: project.binding.profile,
    source: "project_binding",
    agent_directory: null,
    is_complete_inventory: false,
  };
  return [...profiles, projectProfile].sort((left, right) => {
    if (left.name === "default") {
      return -1;
    }
    if (right.name === "default") {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function reduceProjectsState(
  state: ProjectsState,
  event: ProjectsStateEvent,
): ProjectsState {
  switch (event.type) {
    case "disabled":
      return createProjectsState(false);
    case "load_started":
      return {
        ...state,
        loadPhase: "loading",
        loadFailure: null,
      };
    case "load_succeeded":
      return {
        ...state,
        loadPhase: "ready",
        projects: sortProjects(event.workspace.projects),
        knownProfiles: event.workspace.known_profiles,
        loadFailure: null,
      };
    case "load_failed":
      return {
        ...state,
        loadPhase: "failed",
        loadFailure: event.failure,
      };
    case "add_started":
      return {
        ...state,
        mutation: { phase: "adding" },
        addDiagnostics: [],
        editorOpenedProjectId: null,
      };
    case "add_cancelled":
      return {
        ...state,
        mutation: { phase: "idle" },
      };
    case "add_succeeded":
      return {
        ...state,
        projects: upsertProject(state.projects, event.result.project),
        knownProfiles: includeProjectProfile(state.knownProfiles, event.result.project),
        mutation: { phase: "idle" },
        addDiagnostics: event.result.diagnostics,
      };
    case "update_started":
      return {
        ...state,
        mutation: { phase: "updating", projectId: event.projectId },
        addDiagnostics: [],
        editorOpenedProjectId: null,
      };
    case "update_succeeded":
      return {
        ...state,
        projects: upsertProject(state.projects, event.project),
        knownProfiles: includeProjectProfile(state.knownProfiles, event.project),
        mutation: { phase: "idle" },
      };
    case "open_started":
      return {
        ...state,
        mutation: { phase: "opening", projectId: event.projectId },
        editorOpenedProjectId: null,
      };
    case "open_succeeded":
      return {
        ...state,
        mutation: { phase: "idle" },
        editorOpenedProjectId: event.projectId,
      };
    case "mutation_failed":
      return {
        ...state,
        mutation: {
          phase: "failed",
          action: event.action,
          projectId: event.projectId,
          failure: event.failure,
        },
      };
    case "feedback_cleared":
      return {
        ...state,
        mutation: { phase: "idle" },
        addDiagnostics: [],
        editorOpenedProjectId: null,
      };
  }
}
