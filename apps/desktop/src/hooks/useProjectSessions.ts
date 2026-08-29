import { useCallback, useEffect, useReducer, useRef } from "react";

import { classifySessionFailure, type ProjectSessionSummary } from "../domain/session";
import {
  authorizeProjectSessions,
  getProjectSessions,
  previewProjectSession,
  scanProjectSessions,
  type ProjectSessionScope,
} from "../services/session-client";
import {
  createProjectSessionState,
  reduceProjectSessionState,
  type ProjectSessionState,
} from "./project-session-state";

export interface ProjectSessionsController {
  readonly state: ProjectSessionState;
  readonly refresh: () => void;
  readonly authorize: () => void;
  readonly scan: () => void;
  readonly openPreview: (session: ProjectSessionSummary) => void;
  readonly closePreview: () => void;
  readonly clearMutationFailure: () => void;
}

export function useProjectSessions(
  projectId: number,
  profile: string,
  bindingRevision: number,
  active: boolean,
): ProjectSessionsController {
  const [state, dispatch] = useReducer(
    reduceProjectSessionState,
    undefined,
    createProjectSessionState,
  );
  const mounted = useRef(false);
  const activeRef = useRef(active);
  const scopeRef = useRef<ProjectSessionScope>({
    projectId,
    profile,
    bindingRevision,
  });
  const scopeKeyRef = useRef("");
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const mutationInFlight = useRef(false);
  const previewSequence = useRef(0);
  const previewInFlight = useRef(false);
  const scopeKey = `${projectId}\u0000${profile}\u0000${bindingRevision}`;
  activeRef.current = active;
  scopeRef.current = { projectId, profile, bindingRevision };
  scopeKeyRef.current = scopeKey;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback((force = false) => {
    if (!activeRef.current || previewInFlight.current) {
      return;
    }
    const requestId = ++loadSequence.current;
    const requestedScope = scopeRef.current;
    const requestedScopeKey = scopeKeyRef.current;
    dispatch({ type: "load_started" });
    void getProjectSessions(requestedScope, force).then(
      (snapshot) => {
        if (
          mounted.current &&
          activeRef.current &&
          requestedScopeKey === scopeKeyRef.current &&
          requestId === loadSequence.current
        ) {
          dispatch({ type: "load_succeeded", snapshot });
        }
      },
      (error: unknown) => {
        if (
          mounted.current &&
          activeRef.current &&
          requestedScopeKey === scopeKeyRef.current &&
          requestId === loadSequence.current
        ) {
          dispatch({
            type: "load_failed",
            failure: classifySessionFailure(error),
          });
        }
      },
    );
  }, []);

  useEffect(() => {
    loadSequence.current += 1;
    mutationSequence.current += 1;
    mutationInFlight.current = false;
    previewSequence.current += 1;
    previewInFlight.current = false;
    dispatch({ type: "scope_reset" });
  }, [scopeKey]);

  useEffect(() => {
    if (active) {
      refresh();
    }
  }, [active, refresh, scopeKey]);

  const authorize = useCallback(() => {
    if (!activeRef.current || mutationInFlight.current || previewInFlight.current) {
      return;
    }
    mutationInFlight.current = true;
    previewSequence.current += 1;
    loadSequence.current += 1;
    const requestId = ++mutationSequence.current;
    const requestedScope = scopeRef.current;
    const requestedScopeKey = scopeKeyRef.current;
    dispatch({ type: "authorization_started" });
    void authorizeProjectSessions(requestedScope)
      .then(
        (snapshot) => {
          if (
            !mounted.current ||
            requestedScopeKey !== scopeKeyRef.current ||
            requestId !== mutationSequence.current
          ) {
            return;
          }
          loadSequence.current += 1;
          if (snapshot === null) {
            dispatch({ type: "authorization_cancelled" });
            refresh(true);
          } else {
            dispatch({ type: "mutation_succeeded", snapshot });
          }
        },
        (error: unknown) => {
          if (
            mounted.current &&
            requestedScopeKey === scopeKeyRef.current &&
            requestId === mutationSequence.current
          ) {
            loadSequence.current += 1;
            dispatch({
              type: "mutation_failed",
              action: "authorize",
              failure: classifySessionFailure(error),
            });
            refresh(true);
          }
        },
      )
      .finally(() => {
        if (requestId === mutationSequence.current) {
          mutationInFlight.current = false;
        }
      });
  }, [refresh]);

  const scan = useCallback(() => {
    if (!activeRef.current || mutationInFlight.current || previewInFlight.current) {
      return;
    }
    mutationInFlight.current = true;
    previewSequence.current += 1;
    loadSequence.current += 1;
    const requestId = ++mutationSequence.current;
    const requestedScope = scopeRef.current;
    const requestedScopeKey = scopeKeyRef.current;
    dispatch({ type: "scan_started" });
    void scanProjectSessions(requestedScope)
      .then(
        (snapshot) => {
          if (
            mounted.current &&
            requestedScopeKey === scopeKeyRef.current &&
            requestId === mutationSequence.current
          ) {
            loadSequence.current += 1;
            dispatch({ type: "mutation_succeeded", snapshot });
          }
        },
        (error: unknown) => {
          if (
            mounted.current &&
            requestedScopeKey === scopeKeyRef.current &&
            requestId === mutationSequence.current
          ) {
            loadSequence.current += 1;
            dispatch({
              type: "mutation_failed",
              action: "scan",
              failure: classifySessionFailure(error),
            });
            refresh(true);
          }
        },
      )
      .finally(() => {
        if (requestId === mutationSequence.current) {
          mutationInFlight.current = false;
        }
      });
  }, [refresh]);

  const openPreview = useCallback((session: ProjectSessionSummary) => {
    if (!activeRef.current || mutationInFlight.current || previewInFlight.current) {
      return;
    }
    const requestedScope = scopeRef.current;
    const requestedScopeKey = scopeKeyRef.current;
    if (
      session.project_id !== requestedScope.projectId ||
      session.profile !== requestedScope.profile
    ) {
      return;
    }
    previewInFlight.current = true;
    const requestId = ++previewSequence.current;
    dispatch({
      type: "preview_started",
      sessionIndexId: session.session_index_id,
    });
    void previewProjectSession(requestedScope, session.session_index_id, session.session_id)
      .then(
        (preview) => {
          if (
            !mounted.current ||
            requestedScopeKey !== scopeKeyRef.current ||
            requestId !== previewSequence.current
          ) {
            return;
          }
          dispatch(
            activeRef.current ? { type: "preview_succeeded", preview } : { type: "preview_closed" },
          );
        },
        (error: unknown) => {
          if (
            !mounted.current ||
            requestedScopeKey !== scopeKeyRef.current ||
            requestId !== previewSequence.current
          ) {
            return;
          }
          dispatch(
            activeRef.current
              ? {
                  type: "preview_failed",
                  sessionIndexId: session.session_index_id,
                  failure: classifySessionFailure(error),
                }
              : { type: "preview_closed" },
          );
        },
      )
      .finally(() => {
        if (requestId === previewSequence.current) {
          previewInFlight.current = false;
        }
      });
  }, []);

  const closePreview = useCallback(() => {
    previewSequence.current += 1;
    previewInFlight.current = false;
    dispatch({ type: "preview_closed" });
  }, []);

  const clearMutationFailure = useCallback(() => {
    dispatch({ type: "mutation_failure_cleared" });
  }, []);

  return {
    state,
    refresh,
    authorize,
    scan,
    openPreview,
    closePreview,
    clearMutationFailure,
  };
}
