import { describe, expect, it } from "vitest";

import {
  classifySessionFailure,
  decodeProjectSessionPreview,
  decodeProjectSessions,
  InvalidSessionPayloadError,
} from "./session";

function wireSnapshot(): Record<string, unknown> {
  return {
    project_id: 7,
    profile: "default",
    profile_inventory_complete: false,
    root_status: "active",
    last_scanned_at_epoch_ms: 1_000,
    sessions: [
      {
        session_index_id: 11,
        session_id: "session-one",
        project_id: 7,
        profile: "default",
        title: "Session\u001b[31m",
        cwd_display: "/work/example",
        modified_at_epoch_ms: 900,
        created_at_epoch_ms: null,
        read_status: "partial",
        freshness: "fresh",
        model_selector: "provider/model",
        provider: "provider",
        credential_providers: ["provider"],
        message_count: 3,
        size_bytes: 512,
        warning_codes: ["session_tail_incomplete"],
      },
    ],
    diagnostics: [],
  };
}

function wirePreview(): Record<string, unknown> {
  return {
    project_id: 7,
    session_index_id: 11,
    profile: "default",
    session_id: "session-one",
    title: "Session",
    cwd_display: "/work/example",
    read_status: "partial",
    model_selector: "provider/model",
    provider: "provider",
    model_roles: { default: "provider/model" },
    last_model_role: "default",
    thinking_level: "high",
    credential_providers: ["provider"],
    message_count: 2,
    first_message_summary: "first",
    messages: [
      {
        role: "user",
        text: "<script>alert(1)</script>\u001b[31m",
        timestamp: "2026-08-29T00:00:00Z",
      },
    ],
    skipped_record_count: 1,
    warning_codes: ["incomplete_tail_ignored"],
    source_modified_at_epoch_ms: 1_000,
    source_size_bytes: 2_048,
  };
}

describe("project session decoder", () => {
  it("decodes bounded structural metadata and neutralizes display controls", () => {
    const snapshot = decodeProjectSessions(wireSnapshot(), {
      projectId: 7,
      profile: "default",
    });

    expect(snapshot.root_status).toBe("active");
    expect(snapshot.profile_inventory_complete).toBe(false);
    expect(snapshot.sessions[0]).toMatchObject({
      session_index_id: 11,
      title: "Session�[31m",
      created_at_epoch_ms: null,
      read_status: "partial",
      freshness: "fresh",
    });
  });

  it("rejects cross-project and cross-profile rows", () => {
    const wrongProject = wireSnapshot();
    (wrongProject.sessions as Array<Record<string, unknown>>)[0]!.project_id = 8;
    expect(() => decodeProjectSessions(wrongProject, { projectId: 7, profile: "default" })).toThrow(
      InvalidSessionPayloadError,
    );

    const wrongProfile = wireSnapshot();
    (wrongProfile.sessions as Array<Record<string, unknown>>)[0]!.profile = "other";
    expect(() => decodeProjectSessions(wrongProfile, { projectId: 7, profile: "default" })).toThrow(
      InvalidSessionPayloadError,
    );
  });

  it("rejects duplicate row identities and a falsely complete profile inventory", () => {
    const duplicate = wireSnapshot();
    const first = (duplicate.sessions as Array<Record<string, unknown>>)[0]!;
    (duplicate.sessions as Array<Record<string, unknown>>).push({ ...first });
    expect(() => decodeProjectSessions(duplicate)).toThrow(InvalidSessionPayloadError);

    const complete = wireSnapshot();
    complete.profile_inventory_complete = true;
    expect(() => decodeProjectSessions(complete)).toThrow(InvalidSessionPayloadError);
  });

  it("classifies exact backend diagnostics without trusting malformed errors", () => {
    expect(
      classifySessionFailure({
        code: "profile_session_root_offline",
        message: "Offline",
        suggestion: "Reconnect",
        retryable: true,
        technical_detail_redacted: "stage=session_scan",
      }),
    ).toMatchObject({
      kind: "backend",
      diagnostic: { code: "profile_session_root_offline" },
    });
    expect(
      classifySessionFailure({
        code: "bad",
        message: "Bad",
        suggestion: "",
        retryable: false,
        technical_detail_redacted: "",
        unexpected: "field",
      }),
    ).toEqual({ kind: "invoke_failed" });
  });

  it("decodes an in-memory preview only under its exact opaque scope", () => {
    const preview = decodeProjectSessionPreview(wirePreview(), {
      projectId: 7,
      profile: "default",
      sessionIndexId: 11,
      sessionId: "session-one",
    });

    expect(preview.messages[0]?.text).toBe("<script>alert(1)</script>�[31m");
    expect(preview.model_roles).toEqual({ default: "provider/model" });

    expect(() =>
      decodeProjectSessionPreview(wirePreview(), {
        projectId: 7,
        profile: "other",
        sessionIndexId: 11,
        sessionId: "session-one",
      }),
    ).toThrow(InvalidSessionPayloadError);
  });

  it("rejects inconsistent preview model-role metadata", () => {
    const preview = wirePreview();
    preview.model_selector = "other/model";
    expect(() =>
      decodeProjectSessionPreview(preview, {
        projectId: 7,
        profile: "default",
        sessionIndexId: 11,
        sessionId: "session-one",
      }),
    ).toThrow(InvalidSessionPayloadError);
  });
});
