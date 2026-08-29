import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ProjectSessionPreview,
  ProjectSessionSummary,
  ProjectSessionsSnapshot,
} from "../domain/session";
import type { ProjectSessionState } from "../hooks/project-session-state";
import { createTranslator } from "../i18n";
import { ProjectSessionsContent } from "./ProjectSessionsPanel";

const t = createTranslator("zh-CN");

function session(overrides: Partial<ProjectSessionSummary> = {}): ProjectSessionSummary {
  return {
    session_index_id: 10,
    session_id: "session-one",
    project_id: 1,
    profile: "default",
    title: "设计 <script>alert(1)</script>",
    cwd_display: "/work/项目 & tools",
    modified_at_epoch_ms: 1_000,
    created_at_epoch_ms: null,
    read_status: "readable",
    freshness: "fresh",
    model_selector: "provider/model",
    provider: "provider",
    credential_providers: ["provider"],
    message_count: 8,
    size_bytes: 2_048,
    warning_codes: [],
    ...overrides,
  };
}

function snapshot(
  rootStatus: ProjectSessionsSnapshot["root_status"],
  sessions: readonly ProjectSessionSummary[] = [],
): ProjectSessionsSnapshot {
  return {
    project_id: 1,
    profile: "default",
    profile_inventory_complete: false,
    root_status: rootStatus,
    last_scanned_at_epoch_ms: rootStatus === "unconfigured" ? null : 1_100,
    sessions,
    diagnostics: [],
  };
}

function preview(): ProjectSessionPreview {
  return {
    project_id: 1,
    session_index_id: 10,
    profile: "default",
    session_id: "session-one",
    title: "Preview <unsafe>",
    cwd_display: "/work/项目 & tools",
    read_status: "partial",
    model_selector: "provider/model",
    provider: "provider",
    model_roles: { default: "provider/model" },
    last_model_role: "default",
    thinking_level: "high",
    credential_providers: ["provider"],
    message_count: 1,
    first_message_summary: "first <message>",
    messages: [
      {
        role: "user",
        text: "<img src=x onerror=alert(1)>\nsecond line",
        timestamp: "2026-08-29T00:00:00Z",
      },
    ],
    skipped_record_count: 1,
    warning_codes: ["incomplete_tail_ignored"],
    source_modified_at_epoch_ms: 1_000,
    source_size_bytes: 2_048,
  };
}

function state(
  sessionSnapshot: ProjectSessionsSnapshot | null,
  overrides: Partial<ProjectSessionState> = {},
): ProjectSessionState {
  return {
    loadPhase: sessionSnapshot === null ? "loading" : "ready",
    snapshot: sessionSnapshot,
    loadFailure: null,
    mutation: { phase: "idle" },
    preview: { phase: "idle" },
    ...overrides,
  };
}

function render(
  projectState: ProjectSessionState,
  visibleSessions: readonly ProjectSessionSummary[] = projectState.snapshot?.sessions ?? [],
  matchingCount = visibleSessions.length,
  translator = t,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderToStaticMarkup(
    <ProjectSessionsContent
      state={projectState}
      visibleSessions={visibleSessions}
      matchingCount={matchingCount}
      searchQuery=""
      disabled={false}
      locale={locale}
      t={translator}
      onSearchChange={vi.fn()}
      onRefresh={vi.fn()}
      onAuthorize={vi.fn()}
      onScan={vi.fn()}
      onOpenPreview={vi.fn()}
      onClosePreview={vi.fn()}
      onDismissMutationFailure={vi.fn()}
      onShowMore={vi.fn()}
    />,
  );
}

describe("ProjectSessionsContent", () => {
  it("requires explicit native-picker authorization and hides scan before a grant", () => {
    const markup = render(state(snapshot("unconfigured")));

    expect(markup).toContain("管理器不会猜测或扫描 ~/.omp");
    expect(markup).toContain("选择并授权 sessions 目录");
    expect(markup).not.toContain(">重新扫描</button>");
    expect(markup).toContain("会话正文、首条消息和凭证哈希不会写入");
  });

  it("renders escaped structural metadata without a transcript preview", () => {
    const item = session();
    const markup = render(state(snapshot("active", [item])));

    expect(markup).toContain("设计 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>alert(1)</script>");
    expect(markup).toContain("/work/项目 &amp; tools");
    expect(markup).toContain("provider/model");
    expect(markup).toContain("2 KiB");
    expect(markup).toContain("可读取");
    expect(markup).toContain("最新");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("匹配会话数 / 会话总数: 1 / 1");
  });

  it("shows freshness, parser warnings, diagnostics, and progressive-list controls", () => {
    const first = session({
      freshness: "failed",
      read_status: "partial",
      warning_codes: ["session_tail_incomplete"],
    });
    const second = session({ session_index_id: 11, session_id: "session-two" });
    const value = snapshot("active", [first, second]);
    const projectState = state({
      ...value,
      diagnostics: [
        {
          code: "session_listing_entries_skipped",
          message: "跳过 <unsafe>",
          suggestion: "检查目录",
          retryable: true,
          technical_detail_redacted: "",
        },
      ],
    });
    const markup = render(projectState, [first], 2);

    expect(markup).toContain("本次读取失败");
    expect(markup).toContain("部分可读取");
    expect(markup).toContain("session_tail_incomplete");
    expect(markup).toContain("扫描时跳过了无法安全列举");
    expect(markup).not.toContain("&lt;unsafe&gt;");
    expect(markup).toContain("显示更多");
  });

  it("keeps cached rows visible beside a structured scan failure", () => {
    const markup = render(
      state(snapshot("offline", [session()]), {
        mutation: {
          phase: "failed",
          action: "scan",
          failure: {
            kind: "backend",
            diagnostic: {
              code: "profile_session_root_offline",
              message: "会话目录不可访问",
              suggestion: "恢复目录",
              retryable: true,
              technical_detail_redacted: "stage=session_scan",
            },
          },
        },
      }),
    );

    expect(markup).toContain("无法扫描会话");
    expect(markup).toContain("已授权的会话目录当前不可访问");
    expect(markup).toContain("profile_session_root_offline");
    expect(markup).toContain("session-one");
    expect(markup).toContain("会话根离线");
  });

  it("renders an escaped on-demand transcript and marks it as memory-only", () => {
    const markup = render(
      state(snapshot("active", [session()]), {
        preview: { phase: "ready", preview: preview() },
      }),
    );

    expect(markup).toContain("只在当前界面内存中保留");
    expect(markup).toContain("Preview &lt;unsafe&gt;");
    expect(markup).toContain("first &lt;message&gt;");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("incomplete_tail_ignored");
    expect(markup).toContain("关闭预览");
  });

  it("announces a pending preview and disables overlapping row actions", () => {
    const item = session();
    const markup = render(
      state(snapshot("active", [item]), {
        preview: {
          phase: "loading",
          sessionIndexId: item.session_index_id,
        },
      }),
    );

    expect(markup).toContain("正在安全读取会话");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('disabled=""');
  });

  it("rejects incompatible load data with an actionable generic notice", () => {
    const markup = render(
      state(null, {
        loadPhase: "failed",
        loadFailure: { kind: "invalid_payload" },
      }),
    );

    expect(markup).toContain("无法读取会话索引");
    expect(markup).toContain("后端返回了不兼容的会话数据");
    expect(markup).toContain("重试读取");
  });

  it("localizes backend diagnostics instead of leaking Rust-language prose", () => {
    const markup = render(
      state(snapshot("offline"), {
        mutation: {
          phase: "failed",
          action: "scan",
          failure: {
            kind: "backend",
            diagnostic: {
              code: "profile_session_root_offline",
              message: "后端中文消息",
              suggestion: "后端中文建议",
              retryable: true,
              technical_detail_redacted: "",
            },
          },
        },
      }),
      [],
      0,
      createTranslator("en-US"),
      "en-US",
    );

    expect(markup).toContain("The authorized session folder is currently unavailable.");
    expect(markup).not.toContain("后端中文");

    const conflict = render(
      state(snapshot("unconfigured"), {
        mutation: {
          phase: "failed",
          action: "authorize",
          failure: {
            kind: "backend",
            diagnostic: {
              code: "session_root_overlaps_profile",
              message: "wrong language",
              suggestion: "refresh",
              retryable: false,
              technical_detail_redacted: "",
            },
          },
        },
      }),
      [],
      0,
      createTranslator("en-US"),
      "en-US",
    );
    expect(conflict).toContain("Choose a separate, unbound sessions folder");
    expect(conflict).not.toContain("Reload the project");
  });
});
