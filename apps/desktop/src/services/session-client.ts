import { invoke } from "@tauri-apps/api/core";

import {
  decodeProjectSessionPreview,
  decodeProjectSessions,
  InvalidSessionPayloadError,
  type ProjectSessionPreview,
  type ProjectSessionsSnapshot,
} from "../domain/session";

export interface ProjectSessionScope {
  readonly projectId: number;
  readonly profile: string;
  readonly bindingRevision: number;
}

const currentScopedReads = new Map<string, Promise<ProjectSessionsSnapshot>>();
const currentPreviews = new Map<string, Promise<ProjectSessionPreview>>();

function validateScope(scope: ProjectSessionScope): void {
  if (!Number.isSafeInteger(scope.projectId) || scope.projectId < 1) {
    throw new InvalidSessionPayloadError("project_id");
  }
  if (
    typeof scope.profile !== "string" ||
    scope.profile.trim().length === 0 ||
    scope.profile.length > 64 ||
    scope.profile.includes("\0")
  ) {
    throw new InvalidSessionPayloadError("profile");
  }
  if (!Number.isSafeInteger(scope.bindingRevision) || scope.bindingRevision < 1) {
    throw new InvalidSessionPayloadError("binding_revision");
  }
}

function readKey(scope: ProjectSessionScope): string {
  return `${scope.projectId}\u0000${scope.profile}\u0000${scope.bindingRevision}`;
}

function validatePreviewIdentity(sessionIndexId: number, sessionId: string): void {
  if (!Number.isSafeInteger(sessionIndexId) || sessionIndexId < 1) {
    throw new InvalidSessionPayloadError("session_index_id");
  }
  if (
    typeof sessionId !== "string" ||
    sessionId.trim().length === 0 ||
    sessionId.length > 256 ||
    sessionId.includes("\0")
  ) {
    throw new InvalidSessionPayloadError("session_id");
  }
}

export function getProjectSessions(
  scope: ProjectSessionScope,
  force = false,
): Promise<ProjectSessionsSnapshot> {
  try {
    validateScope(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = readKey(scope);
  const current = currentScopedReads.get(key);
  if (!force && current !== undefined) {
    return current;
  }
  const request = invoke<unknown>("project_sessions", { projectId: scope.projectId })
    .then((value) =>
      decodeProjectSessions(value, {
        projectId: scope.projectId,
        profile: scope.profile,
      }),
    )
    .finally(() => {
      if (currentScopedReads.get(key) === request) {
        currentScopedReads.delete(key);
      }
    });
  currentScopedReads.set(key, request);
  return request;
}

export function authorizeProjectSessions(
  scope: ProjectSessionScope,
): Promise<ProjectSessionsSnapshot | null> {
  try {
    validateScope(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<unknown>("authorize_project_sessions", { projectId: scope.projectId }).then(
    (value) =>
      value === null
        ? null
        : decodeProjectSessions(value, {
            projectId: scope.projectId,
            profile: scope.profile,
          }),
  );
}

export function scanProjectSessions(scope: ProjectSessionScope): Promise<ProjectSessionsSnapshot> {
  try {
    validateScope(scope);
  } catch (error) {
    return Promise.reject(error);
  }
  return invoke<unknown>("scan_project_sessions", { projectId: scope.projectId }).then((value) =>
    decodeProjectSessions(value, {
      projectId: scope.projectId,
      profile: scope.profile,
    }),
  );
}

export function previewProjectSession(
  scope: ProjectSessionScope,
  sessionIndexId: number,
  sessionId: string,
): Promise<ProjectSessionPreview> {
  try {
    validateScope(scope);
    validatePreviewIdentity(sessionIndexId, sessionId);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = `${readKey(scope)}\u0000${sessionIndexId}\u0000${sessionId}`;
  const current = currentPreviews.get(key);
  if (current !== undefined) {
    return current;
  }
  const request = invoke<unknown>("preview_project_session", {
    request: {
      project_id: scope.projectId,
      session_index_id: sessionIndexId,
    },
  })
    .then((value) =>
      decodeProjectSessionPreview(value, {
        projectId: scope.projectId,
        profile: scope.profile,
        sessionIndexId,
        sessionId,
      }),
    )
    .finally(() => {
      if (currentPreviews.get(key) === request) {
        currentPreviews.delete(key);
      }
    });
  currentPreviews.set(key, request);
  return request;
}
