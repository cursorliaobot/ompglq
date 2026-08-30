import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectSummary } from "../domain/project";
import type { ProjectsState } from "../hooks/project-state";
import { createTranslator } from "../i18n";
import { ProjectWorkbenchView } from "./ProjectWorkbench";

const t = createTranslator("zh-CN");

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 1,
    target_id: "local",
    canonical_path: "/work/项目 & tools",
    display_path: "/work/项目 & tools",
    git_identity: null,
    created_at_epoch_ms: 100,
    last_used_at_epoch_ms: 200,
    authorization_status: "active",
    binding: {
      id: 11,
      revision: 3,
      path_prefix: "/work/项目 & tools",
      profile: "default",
      profile_source: "project",
      terminal_mode: "embedded",
      terminal_mode_source: "project",
      account_policy: "automatic",
      account_policy_source: "project",
      role_defaults: {},
      allowed_models: [],
      disabled_providers: [],
      updated_at_epoch_ms: 180,
    },
    ...overrides,
  };
}

function state(overrides: Partial<ProjectsState> = {}): ProjectsState {
  return {
    loadPhase: "ready",
    projects: [],
    knownProfiles: [
      {
        name: "default",
        source: "default",
        agent_directory: null,
        is_complete_inventory: false,
      },
    ],
    loadFailure: null,
    mutation: { phase: "idle" },
    addDiagnostics: [],
    editorOpenedProjectId: null,
    ...overrides,
  };
}

function render(projectState: ProjectsState): string {
  return renderToStaticMarkup(
    <ProjectWorkbenchView
      state={projectState}
      locale="zh-CN"
      t={t}
      refresh={vi.fn()}
      addProject={vi.fn()}
      updateProjectBinding={vi.fn()}
      openProjectInCursor={vi.fn()}
      startNewSession={vi.fn()}
      resumeSession={vi.fn()}
      clearFeedback={vi.fn()}
    />,
  );
}

describe("ProjectWorkbenchView", () => {
  it("does not expose project actions before the database is ready", () => {
    const markup = render(state({ loadPhase: "disabled" }));

    expect(markup).toContain("项目功能正在等待本地元数据");
    expect(markup).not.toContain("选择文件夹并添加");
    expect(markup).toContain('aria-busy="false"');
  });

  it("renders an accessible loading state and a real empty state", () => {
    const loading = render(state({ loadPhase: "loading" }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("正在读取项目");

    const empty = render(state());
    expect(empty).toContain("尚未登记项目");
    expect(empty).toContain("选择文件夹并添加");
    expect(empty).toContain("发现范围不完整");
  });

  it("shows supported terminal controls and the server revision", () => {
    const markup = render(state({ projects: [project()] }));

    expect(markup).toContain("/work/项目 &amp; tools");
    expect(markup).toContain("已授权");
    expect(markup).toContain("绑定版本");
    expect(markup).toContain(">3</code>");
    expect(markup).toContain("由 OMP 自动选择");
    expect(markup).toContain("固定到当前 Profile");
    expect(markup).toContain("内嵌终端");
    expect(markup).toContain("外部终端");
    expect(markup).toContain("项目会话");
    expect(markup).not.toContain("固定具体凭证");
  });

  it("exposes a keyboard-accessible fixed Cursor action only for active authorization", () => {
    const active = render(state({ projects: [project()] }));
    expect(active).toContain("用 Cursor 打开");
    expect(active).toContain("更多操作");

    const offline = render(
      state({
        projects: [project({ authorization_status: "offline" })],
      }),
    );
    expect(offline).toContain("重新验证并用 Cursor 打开");

    const revoked = render(
      state({
        projects: [project({ authorization_status: "revoked" })],
      }),
    );
    expect(revoked).toContain("项目目录必须保持在线且授权身份一致");
    expect(revoked).toContain('disabled=""');

    const refreshing = render(
      state({
        loadPhase: "loading",
        projects: [project()],
      }),
    );
    expect(refreshing).toContain('disabled=""');
  });

  it("renders editor launch success and structured failure feedback", () => {
    const success = render(
      state({
        projects: [project()],
        editorOpenedProjectId: 1,
      }),
    );
    expect(success).toContain("已请求 Cursor 打开项目");

    const failure = render(
      state({
        projects: [project()],
        mutation: {
          phase: "failed",
          action: "open",
          projectId: 1,
          failure: {
            kind: "backend",
            diagnostic: {
              code: "cursor_not_found",
              message: "未检测到 Cursor",
              suggestion: "安装 Cursor",
              retryable: true,
              technical_detail_redacted: "stage=cursor_probe",
            },
          },
        },
      }),
    );
    expect(failure).toContain("无法用 Cursor 打开项目");
    expect(failure).toContain("cursor_not_found");
  });

  it("preserves an unsupported credential pin without downgrading its external mode", () => {
    const base = project();
    const markup = render(
      state({
        projects: [
          project({
            binding: {
              ...base.binding,
              terminal_mode: "external",
              account_policy: "credential_pin",
            },
          }),
        ],
      }),
    );

    expect(markup).toContain("外部终端");
    expect(markup).toContain("固定具体凭证");
    expect(markup).toContain("已保持原值");
    expect(markup).not.toContain("保存绑定");
    expect(markup).toContain(
      '<button class="primary-button" type="button" disabled="">用 OMP 新建会话</button>',
    );
  });

  it("keeps launch and binding controls enabled for an external-terminal project", () => {
    const base = project();
    const markup = render(
      state({
        projects: [
          project({
            binding: {
              ...base.binding,
              terminal_mode: "external",
            },
          }),
        ],
      }),
    );

    expect(markup).toContain("外部终端");
    expect(markup).toContain("保存绑定");
    expect(markup).toContain(
      '<button class="primary-button" type="button">用 OMP 新建会话</button>',
    );
  });

  it("keeps project cards visible beside a structured revision conflict", () => {
    const markup = render(
      state({
        projects: [project()],
        mutation: {
          phase: "failed",
          action: "update",
          projectId: 1,
          failure: {
            kind: "backend",
            diagnostic: {
              code: "project_binding_revision_conflict",
              message: "绑定已被其他窗口更新",
              suggestion: "重新加载后再保存",
              retryable: true,
              technical_detail_redacted: "expected_revision=2; actual_revision=3",
            },
          },
        },
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("无法保存项目绑定");
    expect(markup).toContain("project_binding_revision_conflict");
    expect(markup).toContain("重新加载");
    expect(markup).toContain("/work/项目 &amp; tools");
  });

  it("renders add diagnostics as non-blocking, escaped warnings", () => {
    const markup = render(
      state({
        projects: [project()],
        addDiagnostics: [
          {
            code: "git_identity_unavailable",
            message: "<img src=x onerror=alert(1)>",
            suggestion: "项目仍可使用",
            retryable: false,
            technical_detail_redacted: "stage=git_identity",
          },
        ],
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("项目已添加，但有补充诊断");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("stage=git_identity");
  });
});
