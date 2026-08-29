import type {
  ProjectSessionPreview,
  ProjectSessionsSnapshot,
  SessionFailure,
} from "../domain/session";

export type ProjectSessionLoadPhase = "idle" | "loading" | "ready" | "failed";

export type ProjectSessionMutationState =
  | { readonly phase: "idle" }
  | { readonly phase: "authorizing" }
  | { readonly phase: "scanning" }
  | {
      readonly phase: "failed";
      readonly action: "authorize" | "scan";
      readonly failure: SessionFailure;
    };

export type ProjectSessionPreviewState =
  | { readonly phase: "idle" }
  | { readonly phase: "loading"; readonly sessionIndexId: number }
  | { readonly phase: "ready"; readonly preview: ProjectSessionPreview }
  | {
      readonly phase: "failed";
      readonly sessionIndexId: number;
      readonly failure: SessionFailure;
    };

export interface ProjectSessionState {
  readonly loadPhase: ProjectSessionLoadPhase;
  readonly snapshot: ProjectSessionsSnapshot | null;
  readonly loadFailure: SessionFailure | null;
  readonly mutation: ProjectSessionMutationState;
  readonly preview: ProjectSessionPreviewState;
}

export type ProjectSessionStateEvent =
  | { readonly type: "scope_reset" }
  | { readonly type: "load_started" }
  | { readonly type: "load_succeeded"; readonly snapshot: ProjectSessionsSnapshot }
  | { readonly type: "load_failed"; readonly failure: SessionFailure }
  | { readonly type: "authorization_started" }
  | { readonly type: "authorization_cancelled" }
  | { readonly type: "scan_started" }
  | { readonly type: "preview_started"; readonly sessionIndexId: number }
  | { readonly type: "preview_succeeded"; readonly preview: ProjectSessionPreview }
  | {
      readonly type: "preview_failed";
      readonly sessionIndexId: number;
      readonly failure: SessionFailure;
    }
  | { readonly type: "preview_closed" }
  | {
      readonly type: "mutation_succeeded";
      readonly snapshot: ProjectSessionsSnapshot;
    }
  | {
      readonly type: "mutation_failed";
      readonly action: "authorize" | "scan";
      readonly failure: SessionFailure;
    }
  | { readonly type: "mutation_failure_cleared" };

export function createProjectSessionState(): ProjectSessionState {
  return {
    loadPhase: "idle",
    snapshot: null,
    loadFailure: null,
    mutation: { phase: "idle" },
    preview: { phase: "idle" },
  };
}

export function reduceProjectSessionState(
  state: ProjectSessionState,
  event: ProjectSessionStateEvent,
): ProjectSessionState {
  switch (event.type) {
    case "scope_reset":
      return createProjectSessionState();
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
        snapshot: event.snapshot,
        loadFailure: null,
        preview: { phase: "idle" },
      };
    case "load_failed":
      return {
        ...state,
        loadPhase: "failed",
        loadFailure: event.failure,
      };
    case "authorization_started":
      return {
        ...state,
        mutation: { phase: "authorizing" },
        preview: { phase: "idle" },
      };
    case "authorization_cancelled":
      return {
        ...state,
        loadPhase: state.snapshot === null ? "idle" : "ready",
        loadFailure: null,
        mutation: { phase: "idle" },
      };
    case "scan_started":
      return {
        ...state,
        mutation: { phase: "scanning" },
        preview: { phase: "idle" },
      };
    case "preview_started":
      return {
        ...state,
        preview: {
          phase: "loading",
          sessionIndexId: event.sessionIndexId,
        },
      };
    case "preview_succeeded":
      return {
        ...state,
        preview: { phase: "ready", preview: event.preview },
      };
    case "preview_failed":
      return {
        ...state,
        preview: {
          phase: "failed",
          sessionIndexId: event.sessionIndexId,
          failure: event.failure,
        },
      };
    case "preview_closed":
      return {
        ...state,
        preview: { phase: "idle" },
      };
    case "mutation_succeeded":
      return {
        loadPhase: "ready",
        snapshot: event.snapshot,
        loadFailure: null,
        mutation: { phase: "idle" },
        preview: { phase: "idle" },
      };
    case "mutation_failed":
      return {
        ...state,
        mutation: {
          phase: "failed",
          action: event.action,
          failure: event.failure,
        },
      };
    case "mutation_failure_cleared":
      return {
        ...state,
        mutation: { phase: "idle" },
      };
  }
}
