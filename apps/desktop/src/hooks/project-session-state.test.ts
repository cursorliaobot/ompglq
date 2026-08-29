import { describe, expect, it } from "vitest";

import type { ProjectSessionPreview, ProjectSessionsSnapshot } from "../domain/session";
import { createProjectSessionState, reduceProjectSessionState } from "./project-session-state";

function snapshot(rootStatus: ProjectSessionsSnapshot["root_status"]): ProjectSessionsSnapshot {
  return {
    project_id: 1,
    profile: "default",
    profile_inventory_complete: false,
    root_status: rootStatus,
    last_scanned_at_epoch_ms: rootStatus === "unconfigured" ? null : 100,
    sessions: [],
    diagnostics: [],
  };
}

function preview(): ProjectSessionPreview {
  return {
    project_id: 1,
    session_index_id: 7,
    profile: "default",
    session_id: "session-seven",
    title: "Seven",
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
    source_modified_at_epoch_ms: 100,
    source_size_bytes: 200,
  };
}

describe("project session state", () => {
  it("keeps a last good snapshot visible while a refresh fails", () => {
    const ready = reduceProjectSessionState(createProjectSessionState(), {
      type: "load_succeeded",
      snapshot: snapshot("active"),
    });
    const loading = reduceProjectSessionState(ready, { type: "load_started" });
    const failed = reduceProjectSessionState(loading, {
      type: "load_failed",
      failure: { kind: "invoke_failed" },
    });

    expect(loading.snapshot).toBe(ready.snapshot);
    expect(failed.snapshot).toBe(ready.snapshot);
    expect(failed.loadPhase).toBe("failed");
  });

  it("tracks picker cancellation without discarding cached rows", () => {
    const ready = reduceProjectSessionState(createProjectSessionState(), {
      type: "load_succeeded",
      snapshot: snapshot("unconfigured"),
    });
    const authorizing = reduceProjectSessionState(ready, {
      type: "authorization_started",
    });
    const cancelled = reduceProjectSessionState(authorizing, {
      type: "authorization_cancelled",
    });

    expect(authorizing.mutation.phase).toBe("authorizing");
    expect(cancelled.mutation).toEqual({ phase: "idle" });
    expect(cancelled.snapshot).toBe(ready.snapshot);
    expect(cancelled.loadPhase).toBe("ready");

    const cancelledWithoutCache = reduceProjectSessionState(
      reduceProjectSessionState(createProjectSessionState(), {
        type: "authorization_started",
      }),
      { type: "authorization_cancelled" },
    );
    expect(cancelledWithoutCache.loadPhase).toBe("idle");
  });

  it("replaces the cache atomically after a successful scan", () => {
    const scanning = reduceProjectSessionState(createProjectSessionState(), {
      type: "scan_started",
    });
    const scanned = reduceProjectSessionState(scanning, {
      type: "mutation_succeeded",
      snapshot: snapshot("active"),
    });

    expect(scanned.loadPhase).toBe("ready");
    expect(scanned.snapshot?.root_status).toBe("active");
    expect(scanned.mutation).toEqual({ phase: "idle" });
  });

  it("preserves the cache beside a structured mutation failure and can clear it", () => {
    const ready = reduceProjectSessionState(createProjectSessionState(), {
      type: "load_succeeded",
      snapshot: snapshot("offline"),
    });
    const failed = reduceProjectSessionState(ready, {
      type: "mutation_failed",
      action: "scan",
      failure: {
        kind: "backend",
        diagnostic: {
          code: "profile_session_root_offline",
          message: "Offline",
          suggestion: "Reconnect",
          retryable: true,
          technical_detail_redacted: "stage=session_scan",
        },
      },
    });
    const cleared = reduceProjectSessionState(failed, {
      type: "mutation_failure_cleared",
    });

    expect(failed.snapshot).toBe(ready.snapshot);
    expect(failed.mutation).toMatchObject({ phase: "failed", action: "scan" });
    expect(cleared.mutation).toEqual({ phase: "idle" });
  });

  it("drops stale scope data when the project binding changes", () => {
    const ready = reduceProjectSessionState(createProjectSessionState(), {
      type: "load_succeeded",
      snapshot: snapshot("active"),
    });

    expect(reduceProjectSessionState(ready, { type: "scope_reset" })).toEqual(
      createProjectSessionState(),
    );
  });

  it("owns one in-memory preview and clears it on close or scan", () => {
    const loading = reduceProjectSessionState(createProjectSessionState(), {
      type: "preview_started",
      sessionIndexId: 7,
    });
    const ready = reduceProjectSessionState(loading, {
      type: "preview_succeeded",
      preview: preview(),
    });
    const closed = reduceProjectSessionState(ready, {
      type: "preview_closed",
    });
    const scanning = reduceProjectSessionState(ready, {
      type: "scan_started",
    });

    expect(loading.preview).toEqual({
      phase: "loading",
      sessionIndexId: 7,
    });
    expect(ready.preview.phase).toBe("ready");
    expect(closed.preview).toEqual({ phase: "idle" });
    expect(scanning.preview).toEqual({ phase: "idle" });
  });
});
