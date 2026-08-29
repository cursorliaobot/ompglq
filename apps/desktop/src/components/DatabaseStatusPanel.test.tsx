import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseStatusMachineState, DatabaseStatusReport } from "../domain/database";
import { createTranslator } from "../i18n";
import { DatabaseStatusView } from "./DatabaseStatusPanel";

const t = createTranslator("zh-CN");

function report(overrides: Partial<DatabaseStatusReport> = {}): DatabaseStatusReport {
  return {
    revision: 1,
    availability: "ready",
    can_retry: false,
    database_path: "/data/metadata.sqlite3",
    schema_version: 4,
    applied_migrations: [],
    migration_backup_path: null,
    diagnostic: null,
    ...overrides,
  };
}

function render(state: DatabaseStatusMachineState): string {
  return renderToStaticMarkup(<DatabaseStatusView state={state} retry={vi.fn()} t={t} />);
}

describe("DatabaseStatusView", () => {
  it("renders loading and ready states with accessible status metadata", () => {
    expect(render({ phase: "loading" })).toContain('aria-busy="true"');
    expect(
      render({
        phase: "resolved",
        report: report({
          availability: "initializing",
          schema_version: null,
        }),
      }),
    ).toContain('aria-busy="true"');

    const ready = render({
      phase: "resolved",
      report: report({ applied_migrations: [3, 4] }),
    });
    expect(ready).toContain("本地元数据已就绪");
    expect(ready).toContain("/data/metadata.sqlite3");
    expect(ready).toContain("3, 4");
  });

  it("renders recovery guidance and its exact completed backup path", () => {
    const recovery = render({
      phase: "resolved",
      report: report({
        availability: "recovery_required",
        can_retry: true,
        schema_version: null,
        applied_migrations: [],
        migration_backup_path: "/data/metadata.sqlite3.pre-migration-1.bak",
        diagnostic: {
          code: "database_migration_failed",
          message: "迁移失败",
          suggestion: "隔离旧 WAL 后恢复备份",
          retryable: true,
          technical_detail_redacted: "stage=apply",
        },
      }),
    });

    expect(recovery).toContain('role="alert"');
    expect(recovery).toContain("隔离旧 WAL 后恢复备份");
    expect(recovery).toContain("/data/metadata.sqlite3.pre-migration-1.bak");
    expect(recovery).toContain("重新尝试数据库恢复");
  });

  it("escapes untrusted diagnostic text instead of rendering markup", () => {
    const recovery = render({
      phase: "resolved",
      report: report({
        availability: "recovery_required",
        can_retry: false,
        schema_version: null,
        diagnostic: {
          code: "database_failed",
          message: "<img src=x onerror=alert(1)>",
          suggestion: "<script>alert(1)</script>",
          retryable: false,
          technical_detail_redacted: "",
        },
      }),
    });

    expect(recovery).toContain("&lt;img");
    expect(recovery).toContain("&lt;script&gt;");
    expect(recovery).not.toContain("<script>");
    expect(recovery).not.toContain("重新尝试数据库恢复");
  });
});
