import { sanitizeWireText, type ProbeDiagnostic } from "./probe";

export const sessionReadStatuses = ["readable", "partial", "unreadable"] as const;
export type SessionReadStatus = (typeof sessionReadStatuses)[number];

export const sessionFreshnessValues = ["fresh", "stale", "missing", "failed"] as const;
export type SessionFreshness = (typeof sessionFreshnessValues)[number];

export const profileSessionRootStatuses = [
  "unconfigured",
  "active",
  "offline",
  "replaced",
  "revoked",
] as const;
export type ProfileSessionRootStatus = (typeof profileSessionRootStatuses)[number];

export interface ProjectSessionSummary {
  readonly session_index_id: number;
  readonly session_id: string;
  readonly project_id: number;
  readonly profile: string;
  readonly title: string;
  readonly cwd_display: string;
  readonly modified_at_epoch_ms: number;
  readonly created_at_epoch_ms: number | null;
  readonly read_status: SessionReadStatus;
  readonly freshness: SessionFreshness;
  readonly model_selector: string | null;
  readonly provider: string | null;
  readonly credential_providers: readonly string[];
  readonly message_count: number;
  readonly size_bytes: number;
  readonly warning_codes: readonly string[];
}

export interface ProjectSessionsSnapshot {
  readonly project_id: number;
  readonly profile: string;
  readonly profile_inventory_complete: false;
  readonly root_status: ProfileSessionRootStatus;
  readonly last_scanned_at_epoch_ms: number | null;
  readonly sessions: readonly ProjectSessionSummary[];
  readonly diagnostics: readonly ProbeDiagnostic[];
}

export interface ProjectSessionPreviewMessage {
  readonly role: string;
  readonly text: string;
  readonly timestamp: string | null;
}

export interface ProjectSessionPreview {
  readonly project_id: number;
  readonly session_index_id: number;
  readonly profile: string;
  readonly session_id: string;
  readonly title: string;
  readonly cwd_display: string;
  readonly read_status: SessionReadStatus;
  readonly model_selector: string | null;
  readonly provider: string | null;
  readonly model_roles: Readonly<Record<string, string>>;
  readonly last_model_role: string | null;
  readonly thinking_level: string | null;
  readonly credential_providers: readonly string[];
  readonly message_count: number;
  readonly first_message_summary: string | null;
  readonly messages: readonly ProjectSessionPreviewMessage[];
  readonly skipped_record_count: number;
  readonly warning_codes: readonly string[];
  readonly source_modified_at_epoch_ms: number;
  readonly source_size_bytes: number;
}

export interface ExpectedProjectSessionScope {
  readonly projectId: number;
  readonly profile: string;
}

export interface ExpectedProjectSessionPreviewScope extends ExpectedProjectSessionScope {
  readonly sessionIndexId: number;
  readonly sessionId: string;
}

export type SessionFailure =
  | { readonly kind: "invalid_payload" }
  | { readonly kind: "invoke_failed" }
  | { readonly kind: "backend"; readonly diagnostic: ProbeDiagnostic };

const MAX_SESSIONS = 2_000;
const MAX_DIAGNOSTICS = 100;
const MAX_METADATA_VALUES = 512;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export class InvalidSessionPayloadError extends Error {
  public constructor(field: string) {
    super(`Invalid session payload field: ${field}`);
    this.name = "InvalidSessionPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exceedsCharacterLimit(value: string, maximumLength: number): boolean {
  if (value.length > maximumLength * 2) {
    return true;
  }
  let characters = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    characters += 1;
    if (characters > maximumLength) {
      return true;
    }
  }
  return false;
}

function readInteger(
  record: Record<string, unknown>,
  field: string,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidSessionPayloadError(path);
  }
  return value;
}

function readNullableInteger(
  record: Record<string, unknown>,
  field: string,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (record[field] === null) {
    return null;
  }
  return readInteger(record, field, path, minimum, maximum);
}

function readText(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    exceedsCharacterLimit(value, maximumLength) ||
    value.includes("\0")
  ) {
    throw new InvalidSessionPayloadError(path);
  }
  const text = sanitizeWireText(value, maximumLength);
  if (!allowEmpty && text.trim().length === 0) {
    throw new InvalidSessionPayloadError(path);
  }
  return text;
}

function readNullableText(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximumLength: number,
): string | null {
  if (record[field] === null) {
    return null;
  }
  return readText(record, field, path, maximumLength);
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  path: string,
  values: readonly T[],
): T {
  const value = record[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new InvalidSessionPayloadError(path);
  }
  return value as T;
}

function readArray(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximumLength: number,
): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new InvalidSessionPayloadError(path);
  }
  return value;
}

function readUniqueTextArray(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximumLength: number,
  maximumTextLength: number,
): readonly string[] {
  const values = readArray(record, field, path, maximumLength).map((value, index) => {
    if (typeof value !== "string") {
      throw new InvalidSessionPayloadError(`${path}.${index}`);
    }
    return readText({ value }, "value", `${path}.${index}`, maximumTextLength);
  });
  if (new Set(values).size !== values.length) {
    throw new InvalidSessionPayloadError(path);
  }
  return values;
}

function decodeDiagnostic(
  value: unknown,
  path: string,
  requireExactShape = false,
): ProbeDiagnostic {
  if (!isRecord(value)) {
    throw new InvalidSessionPayloadError(path);
  }
  const fields = Object.keys(value);
  if (
    requireExactShape &&
    (fields.length !== 5 ||
      !fields.every((field) =>
        ["code", "message", "suggestion", "retryable", "technical_detail_redacted"].includes(field),
      ))
  ) {
    throw new InvalidSessionPayloadError(path);
  }
  if (typeof value.retryable !== "boolean") {
    throw new InvalidSessionPayloadError(`${path}.retryable`);
  }
  return {
    code: readText(value, "code", `${path}.code`, 160),
    message: readText(value, "message", `${path}.message`, 2_000),
    suggestion: readText(value, "suggestion", `${path}.suggestion`, 2_000, true),
    retryable: value.retryable,
    technical_detail_redacted: readText(
      value,
      "technical_detail_redacted",
      `${path}.technical_detail_redacted`,
      4_000,
      true,
    ),
  };
}

function decodeSession(value: unknown, path: string): ProjectSessionSummary {
  if (!isRecord(value)) {
    throw new InvalidSessionPayloadError(path);
  }
  return {
    session_index_id: readInteger(value, "session_index_id", `${path}.session_index_id`, 1),
    session_id: readText(value, "session_id", `${path}.session_id`, 256),
    project_id: readInteger(value, "project_id", `${path}.project_id`, 1),
    profile: readText(value, "profile", `${path}.profile`, 64),
    title: readText(value, "title", `${path}.title`, 2_048, true),
    cwd_display: readText(value, "cwd_display", `${path}.cwd_display`, 32_768),
    modified_at_epoch_ms: readInteger(
      value,
      "modified_at_epoch_ms",
      `${path}.modified_at_epoch_ms`,
      0,
      MAX_TIMESTAMP,
    ),
    created_at_epoch_ms: readNullableInteger(
      value,
      "created_at_epoch_ms",
      `${path}.created_at_epoch_ms`,
      0,
      MAX_TIMESTAMP,
    ),
    read_status: readEnum(value, "read_status", `${path}.read_status`, sessionReadStatuses),
    freshness: readEnum(value, "freshness", `${path}.freshness`, sessionFreshnessValues),
    model_selector: readNullableText(value, "model_selector", `${path}.model_selector`, 512),
    provider: readNullableText(value, "provider", `${path}.provider`, 256),
    credential_providers: readUniqueTextArray(
      value,
      "credential_providers",
      `${path}.credential_providers`,
      MAX_METADATA_VALUES,
      256,
    ),
    message_count: readInteger(value, "message_count", `${path}.message_count`, 0),
    size_bytes: readInteger(value, "size_bytes", `${path}.size_bytes`, 0),
    warning_codes: readUniqueTextArray(
      value,
      "warning_codes",
      `${path}.warning_codes`,
      MAX_METADATA_VALUES,
      160,
    ),
  };
}

function decodeModelRoles(value: unknown, path: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new InvalidSessionPayloadError(path);
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new InvalidSessionPayloadError(path);
  }
  const decoded = entries.map(([rawRole, rawModel], index) => {
    if (typeof rawModel !== "string") {
      throw new InvalidSessionPayloadError(`${path}.${index}`);
    }
    const role = readText({ value: rawRole }, "value", `${path}.${index}.role`, 64);
    const model = readText({ value: rawModel }, "value", `${path}.${index}.model`, 512);
    return [role, model] as const;
  });
  if (new Set(decoded.map(([role]) => role)).size !== decoded.length) {
    throw new InvalidSessionPayloadError(path);
  }
  return Object.fromEntries(decoded);
}

function decodePreviewMessage(value: unknown, path: string): ProjectSessionPreviewMessage {
  if (!isRecord(value)) {
    throw new InvalidSessionPayloadError(path);
  }
  return {
    role: readText(value, "role", `${path}.role`, 64),
    text: readText(value, "text", `${path}.text`, 16 * 1_024, true),
    timestamp: readNullableText(value, "timestamp", `${path}.timestamp`, 128),
  };
}

export function decodeProjectSessions(
  value: unknown,
  expectedScope?: ExpectedProjectSessionScope,
): ProjectSessionsSnapshot {
  if (!isRecord(value)) {
    throw new InvalidSessionPayloadError("root");
  }
  const projectId = readInteger(value, "project_id", "project_id", 1);
  if (expectedScope !== undefined && projectId !== expectedScope.projectId) {
    throw new InvalidSessionPayloadError("project_id");
  }
  const profile = readText(value, "profile", "profile", 64);
  if (expectedScope !== undefined && profile !== expectedScope.profile) {
    throw new InvalidSessionPayloadError("profile");
  }
  if (value.profile_inventory_complete !== false) {
    throw new InvalidSessionPayloadError("profile_inventory_complete");
  }
  const sessions = readArray(value, "sessions", "sessions", MAX_SESSIONS).map((session, index) =>
    decodeSession(session, `sessions.${index}`),
  );
  if (
    sessions.some((session) => session.project_id !== projectId || session.profile !== profile) ||
    new Set(sessions.map((session) => session.session_index_id)).size !== sessions.length
  ) {
    throw new InvalidSessionPayloadError("sessions.scope");
  }
  return {
    project_id: projectId,
    profile,
    profile_inventory_complete: false,
    root_status: readEnum(value, "root_status", "root_status", profileSessionRootStatuses),
    last_scanned_at_epoch_ms: readNullableInteger(
      value,
      "last_scanned_at_epoch_ms",
      "last_scanned_at_epoch_ms",
      0,
      MAX_TIMESTAMP,
    ),
    sessions,
    diagnostics: readArray(value, "diagnostics", "diagnostics", MAX_DIAGNOSTICS).map(
      (diagnostic, index) => decodeDiagnostic(diagnostic, `diagnostics.${index}`),
    ),
  };
}

export function decodeProjectSessionPreview(
  value: unknown,
  expectedScope: ExpectedProjectSessionPreviewScope,
): ProjectSessionPreview {
  if (!isRecord(value)) {
    throw new InvalidSessionPayloadError("preview");
  }
  const projectId = readInteger(value, "project_id", "preview.project_id", 1);
  const sessionIndexId = readInteger(value, "session_index_id", "preview.session_index_id", 1);
  const profile = readText(value, "profile", "preview.profile", 64);
  const sessionId = readText(value, "session_id", "preview.session_id", 256);
  if (
    projectId !== expectedScope.projectId ||
    sessionIndexId !== expectedScope.sessionIndexId ||
    profile !== expectedScope.profile ||
    sessionId !== expectedScope.sessionId
  ) {
    throw new InvalidSessionPayloadError("preview.scope");
  }
  const modelRoles = decodeModelRoles(value.model_roles, "preview.model_roles");
  const modelSelector = readNullableText(value, "model_selector", "preview.model_selector", 512);
  const lastModelRole = readNullableText(value, "last_model_role", "preview.last_model_role", 64);
  if (
    (lastModelRole !== null && !Object.prototype.hasOwnProperty.call(modelRoles, lastModelRole)) ||
    (modelRoles.default ?? null) !== modelSelector
  ) {
    throw new InvalidSessionPayloadError("preview.model_roles");
  }
  const messages = readArray(value, "messages", "preview.messages", 200).map((message, index) =>
    decodePreviewMessage(message, `preview.messages.${index}`),
  );
  let totalCharacters = 0;
  for (const message of messages) {
    const iterator = message.text[Symbol.iterator]();
    while (!iterator.next().done) {
      totalCharacters += 1;
      if (totalCharacters > 256 * 1_024) {
        throw new InvalidSessionPayloadError("preview.messages.total");
      }
    }
  }
  return {
    project_id: projectId,
    session_index_id: sessionIndexId,
    profile,
    session_id: sessionId,
    title: readText(value, "title", "preview.title", 2_048, true),
    cwd_display: readText(value, "cwd_display", "preview.cwd_display", 32_768),
    read_status: readEnum(value, "read_status", "preview.read_status", sessionReadStatuses),
    model_selector: modelSelector,
    provider: readNullableText(value, "provider", "preview.provider", 256),
    model_roles: modelRoles,
    last_model_role: lastModelRole,
    thinking_level: readNullableText(value, "thinking_level", "preview.thinking_level", 64),
    credential_providers: readUniqueTextArray(
      value,
      "credential_providers",
      "preview.credential_providers",
      MAX_METADATA_VALUES,
      256,
    ),
    message_count: readInteger(value, "message_count", "preview.message_count", 0),
    first_message_summary: readNullableText(
      value,
      "first_message_summary",
      "preview.first_message_summary",
      512,
    ),
    messages,
    skipped_record_count: readInteger(
      value,
      "skipped_record_count",
      "preview.skipped_record_count",
      0,
    ),
    warning_codes: readUniqueTextArray(
      value,
      "warning_codes",
      "preview.warning_codes",
      MAX_METADATA_VALUES,
      160,
    ),
    source_modified_at_epoch_ms: readInteger(
      value,
      "source_modified_at_epoch_ms",
      "preview.source_modified_at_epoch_ms",
      0,
      MAX_TIMESTAMP,
    ),
    source_size_bytes: readInteger(value, "source_size_bytes", "preview.source_size_bytes", 0),
  };
}

export function classifySessionFailure(error: unknown): SessionFailure {
  if (error instanceof InvalidSessionPayloadError) {
    return { kind: "invalid_payload" };
  }
  try {
    return { kind: "backend", diagnostic: decodeDiagnostic(error, "error", true) };
  } catch {
    return { kind: "invoke_failed" };
  }
}
