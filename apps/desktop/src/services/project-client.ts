import { invoke } from "@tauri-apps/api/core";

import {
  decodeAddProjectResult,
  decodeOpenProjectInEditorResult,
  decodeProjectSummary,
  decodeProjectWorkspace,
  type AddProjectResult,
  type OpenProjectInEditorResult,
  type ProjectBindingDraft,
  type ProjectSummary,
  type ProjectWorkspace,
  type UpdateProjectBindingRequest,
} from "../domain/project";

let currentWorkspaceRequest: Promise<ProjectWorkspace> | null = null;

export function getProjectWorkspace(force = false): Promise<ProjectWorkspace> {
  if (!force && currentWorkspaceRequest !== null) {
    return currentWorkspaceRequest;
  }

  const request = invoke<unknown>("project_workspace")
    .then(decodeProjectWorkspace)
    .finally(() => {
      if (currentWorkspaceRequest === request) {
        currentWorkspaceRequest = null;
      }
    });
  currentWorkspaceRequest = request;
  return request;
}

export function addProject(request: ProjectBindingDraft): Promise<AddProjectResult | null> {
  return invoke<unknown>("add_project", {
    request: {
      profile: request.profile,
      terminal_mode: request.terminal_mode,
      account_policy: request.account_policy,
    },
  }).then((value) => (value === null ? null : decodeAddProjectResult(value)));
}

export function updateProjectBinding(
  request: UpdateProjectBindingRequest,
): Promise<ProjectSummary> {
  return invoke<unknown>("update_project_binding", {
    request: {
      project_id: request.project_id,
      expected_revision: request.expected_revision,
      profile: request.profile,
      terminal_mode: request.terminal_mode,
      account_policy: request.account_policy,
    },
  }).then(decodeProjectSummary);
}

export function openProjectInCursor(projectId: number): Promise<OpenProjectInEditorResult> {
  return invoke<unknown>("open_project_in_editor", {
    request: {
      project_id: projectId,
      editor_id: "cursor",
    },
  }).then(decodeOpenProjectInEditorResult);
}
