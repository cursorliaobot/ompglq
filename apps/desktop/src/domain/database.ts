import { sanitizeWireText, type ProbeDiagnostic } from "./probe";

export const databaseAvailabilities = ["initializing", "ready", "recovery_required"] as const;
export type DatabaseAvailability = (typeof databaseAvailabilities)[number];

export interface DatabaseStatusReport {
  readonly revision: number;
  readonly availability: DatabaseAvailability;
  readonly can_retry: boolean;
  readonly database_path: string | null;
  readonly schema_version: number | null;
  readonly applied_migrations: readonly number[];
  readonly migration_backup_path: string | null;
  readonly diagnostic: ProbeDiagnostic | null;
}

export type DatabaseStatusFailureCode = "invoke_failed" | "invalid_payload";

export type DatabaseStatusMachineState =
  | { readonly phase: "loading" }
  | { readonly phase: "resolved"; readonly report: DatabaseStatusReport }
  | { readonly phase: "failed"; readonly code: DatabaseStatusFailureCode };

export class InvalidDatabaseStatusPayloadError extends Error {
  public constructor(field: string) {
    super(`Invalid database status payload field: ${field}`);
    this.name = "InvalidDatabaseStatusPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(
  record: Record<string, unknown>,
  field: string,
  options: { readonly allowEmpty?: boolean; readonly maxLength?: number } = {},
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new InvalidDatabaseStatusPayloadError(field);
  }
  const text = sanitizeWireText(value, options.maxLength ?? 4_096);
  if (options.allowEmpty !== true && text.trim().length === 0) {
    throw new InvalidDatabaseStatusPayloadError(field);
  }
  return text;
}

function readNullableText(
  record: Record<string, unknown>,
  field: string,
  maxLength = 8_192,
): string | null {
  if (record[field] === null) {
    return null;
  }
  return readText(record, field, { maxLength });
}

function readInteger(
  record: Record<string, unknown>,
  field: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (options.minimum ?? 0) ||
    value > (options.maximum ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvalidDatabaseStatusPayloadError(field);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new InvalidDatabaseStatusPayloadError(field);
  }
  return value;
}

function readNullableInteger(
  record: Record<string, unknown>,
  field: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number | null {
  if (record[field] === null) {
    return null;
  }
  return readInteger(record, field, options);
}

function readDiagnostic(value: unknown): ProbeDiagnostic | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new InvalidDatabaseStatusPayloadError("diagnostic");
  }
  if (typeof value.retryable !== "boolean") {
    throw new InvalidDatabaseStatusPayloadError("diagnostic.retryable");
  }

  return {
    code: readText(value, "code", { maxLength: 160 }),
    message: readText(value, "message", { maxLength: 2_000 }),
    suggestion: readText(value, "suggestion", {
      allowEmpty: true,
      maxLength: 2_000,
    }),
    retryable: value.retryable,
    technical_detail_redacted: readText(value, "technical_detail_redacted", {
      allowEmpty: true,
      maxLength: 4_000,
    }),
  };
}

function readAppliedMigrations(record: Record<string, unknown>): readonly number[] {
  const value = record.applied_migrations;
  if (!Array.isArray(value) || value.length > 64) {
    throw new InvalidDatabaseStatusPayloadError("applied_migrations");
  }

  const versions = value.map((version, index) => {
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 1_000_000
    ) {
      throw new InvalidDatabaseStatusPayloadError(`applied_migrations.${index}`);
    }
    return version;
  });
  if (versions.some((version, index) => index > 0 && version <= versions[index - 1]!)) {
    throw new InvalidDatabaseStatusPayloadError("applied_migrations");
  }
  return versions;
}

export function decodeDatabaseStatusReport(value: unknown): DatabaseStatusReport {
  if (!isRecord(value)) {
    throw new InvalidDatabaseStatusPayloadError("root");
  }

  const availability = value.availability;
  if (
    typeof availability !== "string" ||
    !databaseAvailabilities.includes(availability as DatabaseAvailability)
  ) {
    throw new InvalidDatabaseStatusPayloadError("availability");
  }

  const report: DatabaseStatusReport = {
    revision: readInteger(value, "revision", { minimum: 1 }),
    availability: availability as DatabaseAvailability,
    can_retry: readBoolean(value, "can_retry"),
    database_path: readNullableText(value, "database_path"),
    schema_version: readNullableInteger(value, "schema_version", {
      minimum: 1,
      maximum: 1_000_000,
    }),
    applied_migrations: readAppliedMigrations(value),
    migration_backup_path: readNullableText(value, "migration_backup_path"),
    diagnostic: readDiagnostic(value.diagnostic),
  };

  if (
    report.availability === "initializing" &&
    (report.can_retry ||
      report.schema_version !== null ||
      report.applied_migrations.length !== 0 ||
      report.migration_backup_path !== null ||
      report.diagnostic !== null)
  ) {
    throw new InvalidDatabaseStatusPayloadError("initializing_invariants");
  }
  if (
    report.availability === "ready" &&
    (report.can_retry ||
      report.database_path === null ||
      report.schema_version === null ||
      report.diagnostic !== null)
  ) {
    throw new InvalidDatabaseStatusPayloadError("ready_invariants");
  }
  if (
    report.availability === "recovery_required" &&
    (report.schema_version !== null ||
      report.applied_migrations.length !== 0 ||
      report.diagnostic === null)
  ) {
    throw new InvalidDatabaseStatusPayloadError("recovery_invariants");
  }

  return report;
}
