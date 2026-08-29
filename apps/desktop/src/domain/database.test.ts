import { describe, expect, it } from "vitest";

import { decodeDatabaseStatusReport, InvalidDatabaseStatusPayloadError } from "./database";

function readyReport(): Record<string, unknown> {
  return {
    revision: 1,
    availability: "ready",
    can_retry: false,
    database_path: "/home/test/.local/share/omp/metadata.sqlite3",
    schema_version: 4,
    applied_migrations: [1, 2, 3, 4],
    migration_backup_path: null,
    diagnostic: null,
  };
}

function recoveryReport(): Record<string, unknown> {
  return {
    revision: 2,
    availability: "recovery_required",
    can_retry: true,
    database_path: "/home/test/.local/share/omp/metadata.sqlite3",
    schema_version: null,
    applied_migrations: [],
    migration_backup_path: "/home/test/.local/share/omp/metadata.sqlite3.pre-migration-1-1-0.bak",
    diagnostic: {
      code: "database_migration_failed",
      message: "Migration failed",
      suggestion: "Restore the backup",
      retryable: true,
      technical_detail_redacted: "stage=apply",
    },
  };
}

describe("database status decoder", () => {
  it("accepts ready and recovery snapshots", () => {
    expect(decodeDatabaseStatusReport(readyReport()).availability).toBe("ready");
    expect(decodeDatabaseStatusReport(recoveryReport()).availability).toBe("recovery_required");
  });

  it("accepts an observable initialization snapshot", () => {
    const value = readyReport();
    value.availability = "initializing";
    value.database_path = "/data/metadata.sqlite3";
    value.schema_version = null;
    value.applied_migrations = [];
    value.can_retry = false;
    expect(decodeDatabaseStatusReport(value).availability).toBe("initializing");
  });

  it("sanitizes display-spoofing characters in paths and diagnostics", () => {
    const value = recoveryReport();
    value.database_path = "/safe/\u202Ehidden";
    const diagnostic = value.diagnostic as Record<string, unknown>;
    diagnostic.message = "failed\u0007";

    const decoded = decodeDatabaseStatusReport(value);
    expect(decoded.database_path).toBe("/safe/�hidden");
    expect(decoded.diagnostic?.message).toBe("failed�");
  });

  it("rejects impossible ready snapshots", () => {
    const value = readyReport();
    value.diagnostic = recoveryReport().diagnostic;
    expect(() => decodeDatabaseStatusReport(value)).toThrow(InvalidDatabaseStatusPayloadError);
  });

  it("rejects impossible recovery snapshots", () => {
    const value = recoveryReport();
    value.applied_migrations = [1];
    expect(() => decodeDatabaseStatusReport(value)).toThrow(InvalidDatabaseStatusPayloadError);
  });

  it("rejects unordered, duplicate, or oversized migration lists", () => {
    for (const versions of [[1, 1], [2, 1], Array.from({ length: 65 }, (_, index) => index + 1)]) {
      const value = readyReport();
      value.applied_migrations = versions;
      expect(() => decodeDatabaseStatusReport(value)).toThrow(InvalidDatabaseStatusPayloadError);
    }
  });

  it("rejects unknown availability values", () => {
    const value = readyReport();
    value.availability = "degraded";
    expect(() => decodeDatabaseStatusReport(value)).toThrow(InvalidDatabaseStatusPayloadError);
  });
});
