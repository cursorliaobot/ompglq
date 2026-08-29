import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  classifyProjectFailure,
  type ProjectBindingDraft,
  type UpdateProjectBindingRequest,
} from "../domain/project";
import {
  addProject as requestAddProject,
  getProjectWorkspace,
  openProjectInCursor as requestOpenProjectInCursor,
  updateProjectBinding as requestUpdateProjectBinding,
} from "../services/project-client";
import { createProjectsState, reduceProjectsState, type ProjectsState } from "./project-state";

export interface ProjectsController {
  readonly state: ProjectsState;
  readonly refresh: () => void;
  readonly addProject: (request: ProjectBindingDraft) => void;
  readonly updateProjectBinding: (request: UpdateProjectBindingRequest) => void;
  readonly openProjectInCursor: (projectId: number) => void;
  readonly clearFeedback: () => void;
}

export function useProjects(enabled: boolean): ProjectsController {
  const [state, dispatch] = useReducer(reduceProjectsState, enabled, createProjectsState);
  const mounted = useRef(false);
  const enabledRef = useRef(enabled);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const mutationInFlight = useRef(false);
  enabledRef.current = enabled;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback((force = false) => {
    if (!enabledRef.current) {
      return;
    }
    const requestId = ++loadSequence.current;
    dispatch({ type: "load_started" });
    void getProjectWorkspace(force).then(
      (workspace) => {
        if (mounted.current && enabledRef.current && requestId === loadSequence.current) {
          dispatch({ type: "load_succeeded", workspace });
        }
      },
      (error: unknown) => {
        if (mounted.current && enabledRef.current && requestId === loadSequence.current) {
          dispatch({ type: "load_failed", failure: classifyProjectFailure(error) });
        }
      },
    );
  }, []);

  useEffect(() => {
    if (enabled) {
      refresh();
      return;
    }

    loadSequence.current += 1;
    mutationSequence.current += 1;
    mutationInFlight.current = false;
    dispatch({ type: "disabled" });
  }, [enabled, refresh]);

  const addProject = useCallback((request: ProjectBindingDraft) => {
    if (!enabledRef.current || mutationInFlight.current) {
      return;
    }
    mutationInFlight.current = true;
    const requestId = ++mutationSequence.current;
    dispatch({ type: "add_started" });

    void requestAddProject(request)
      .then(
        (result) => {
          if (!mounted.current || !enabledRef.current || requestId !== mutationSequence.current) {
            return;
          }
          dispatch(result === null ? { type: "add_cancelled" } : { type: "add_succeeded", result });
        },
        (error: unknown) => {
          if (mounted.current && enabledRef.current && requestId === mutationSequence.current) {
            dispatch({
              type: "mutation_failed",
              action: "add",
              projectId: null,
              failure: classifyProjectFailure(error),
            });
          }
        },
      )
      .finally(() => {
        if (requestId === mutationSequence.current) {
          mutationInFlight.current = false;
        }
      });
  }, []);

  const updateProjectBinding = useCallback((request: UpdateProjectBindingRequest) => {
    if (!enabledRef.current || mutationInFlight.current) {
      return;
    }
    mutationInFlight.current = true;
    const requestId = ++mutationSequence.current;
    dispatch({ type: "update_started", projectId: request.project_id });

    void requestUpdateProjectBinding(request)
      .then(
        (project) => {
          if (mounted.current && enabledRef.current && requestId === mutationSequence.current) {
            dispatch({ type: "update_succeeded", project });
          }
        },
        (error: unknown) => {
          if (mounted.current && enabledRef.current && requestId === mutationSequence.current) {
            dispatch({
              type: "mutation_failed",
              action: "update",
              projectId: request.project_id,
              failure: classifyProjectFailure(error),
            });
          }
        },
      )
      .finally(() => {
        if (requestId === mutationSequence.current) {
          mutationInFlight.current = false;
        }
      });
  }, []);

  const openProjectInCursor = useCallback(
    (projectId: number) => {
      if (!enabledRef.current || mutationInFlight.current) {
        return;
      }
      mutationInFlight.current = true;
      const requestId = ++mutationSequence.current;
      dispatch({ type: "open_started", projectId });

      void requestOpenProjectInCursor(projectId)
        .then(
          () => {
            if (mounted.current && enabledRef.current && requestId === mutationSequence.current) {
              dispatch({ type: "open_succeeded", projectId });
              refresh(true);
            }
          },
          (error: unknown) => {
            if (mounted.current && enabledRef.current && requestId === mutationSequence.current) {
              dispatch({
                type: "mutation_failed",
                action: "open",
                projectId,
                failure: classifyProjectFailure(error),
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
    },
    [refresh],
  );

  const clearFeedback = useCallback(() => {
    dispatch({ type: "feedback_cleared" });
  }, []);

  return {
    state,
    refresh,
    addProject,
    updateProjectBinding,
    openProjectInCursor,
    clearFeedback,
  };
}
