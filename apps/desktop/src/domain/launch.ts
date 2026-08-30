import { sanitizeWireText, type ProbeDiagnostic } from "./probe";

export const launchActions = ["new", "resume"] as const;
export type LaunchAction = (typeof launchActions)[number];

export const terminalRunStatuses = ["running", "exited", "failed"] as const;
export type TerminalRunStatus = (typeof terminalRunStatuses)[number];

export const launchTerminalModes = ["embedded", "external"] as const;
export type LaunchTerminalMode = (typeof launchTerminalModes)[number];

export const launchSettingSources = [
  "launch_override",
  "session",
  "project",
  "profile",
  "global",
] as const;
export type LaunchSettingSource = (typeof launchSettingSources)[number];

export const launchModelRoles = ["default", "smol", "slow", "plan"] as const;
export type LaunchModelRole = (typeof launchModelRoles)[number];

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export interface LaunchScope {
  readonly projectId: number;
  readonly bindingRevision: number;
  readonly action: LaunchAction;
  readonly sessionIndexId: number | null;
}

export interface LaunchModel {
  readonly provider: string;
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly context_window: number | null;
  readonly max_tokens: number | null;
  readonly reasoning: boolean;
  readonly thinking: readonly string[];
  readonly input: readonly string[];
}

export interface LaunchOptions {
  readonly project_id: number;
  readonly binding_revision: number;
  readonly action: LaunchAction;
  readonly session_index_id: number | null;
  readonly session_id: string | null;
  readonly profile: string;
  readonly cwd_display: string;
  readonly model_roles: Readonly<Partial<Record<LaunchModelRole, string>>>;
  readonly thinking_level: ThinkingLevel | null;
  readonly credential_policy: "automatic" | "profile";
  readonly terminal_mode: LaunchTerminalMode;
  readonly available_models: readonly LaunchModel[];
  readonly warnings: readonly string[];
  readonly setting_sources: Readonly<Record<string, LaunchSettingSource>>;
}

export interface PrepareLaunchInput extends LaunchScope {
  readonly modelRoles: Readonly<Partial<Record<LaunchModelRole, string>>>;
  readonly thinkingLevel: ThinkingLevel | null;
}

export interface PreparedLaunchPlan {
  readonly plan_id: string;
  readonly input_fingerprint: string;
  readonly created_at_epoch_ms: number;
  readonly expires_at_epoch_ms: number;
  readonly project_id: number;
  readonly binding_revision: number;
  readonly action: LaunchAction;
  readonly session_index_id: number | null;
  readonly session_id: string | null;
  readonly profile: string;
  readonly cwd_display: string;
  readonly model_roles: Readonly<Partial<Record<LaunchModelRole, string>>>;
  readonly thinking_level: ThinkingLevel | null;
  readonly credential_policy: "automatic" | "profile";
  readonly terminal_mode: LaunchTerminalMode;
  readonly display_preview_redacted: string;
  readonly environment: readonly LaunchEnvironmentSummary[];
  readonly warnings: readonly string[];
  readonly setting_sources: Readonly<Record<string, LaunchSettingSource>>;
}

export interface LaunchEnvironmentSummary {
  readonly name: string;
  readonly source: "manager_process";
  readonly present: boolean;
}

export interface ExternalTerminalLaunch {
  readonly terminal_id: string;
  readonly process_id: number | null;
  readonly project_id: number;
  readonly action: LaunchAction;
  readonly session_id: string | null;
  readonly profile: string;
  readonly model_roles: Readonly<Partial<Record<LaunchModelRole, string>>>;
  readonly thinking_level: ThinkingLevel | null;
  readonly launched_at_epoch_ms: number;
}

export type LaunchExecutionResult =
  | { readonly kind: "embedded"; readonly run: PtyRunSnapshot }
  | { readonly kind: "external"; readonly launch: ExternalTerminalLaunch };

export interface PtyRunSnapshot {
  readonly run_id: string;
  readonly project_id: number;
  readonly action: LaunchAction;
  readonly session_id: string | null;
  readonly title: string;
  readonly profile: string;
  readonly model_roles: Readonly<Partial<Record<LaunchModelRole, string>>>;
  readonly thinking_level: ThinkingLevel | null;
  readonly status: TerminalRunStatus;
  readonly process_id: number | null;
  readonly started_at_epoch_ms: number;
  readonly finished_at_epoch_ms: number | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly rows: number;
  readonly cols: number;
  readonly first_available_sequence: number;
  readonly last_sequence: number;
  readonly output_truncated: boolean;
}

export interface PtyOutputFrame {
  readonly run_id: string;
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

export interface PtyOutputBatch {
  readonly run: PtyRunSnapshot;
  readonly frames: readonly PtyOutputFrame[];
  readonly gap_before_first_frame: boolean;
}

export type LaunchFailure =
  | { readonly kind: "invalid_payload" }
  | { readonly kind: "invoke_failed" }
  | { readonly kind: "backend"; readonly diagnostic: ProbeDiagnostic };

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class InvalidLaunchPayloadError extends Error {
  public constructor(field: string) {
    super(`Invalid launch payload field: ${field}`);
    this.name = "InvalidLaunchPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
  allowEmpty = false,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new InvalidLaunchPayloadError(path);
  }
  const text = sanitizeWireText(value, maximum);
  if (!allowEmpty && text.trim().length === 0) {
    throw new InvalidLaunchPayloadError(path);
  }
  return text;
}

function readInteger(
  record: Record<string, unknown>,
  field: string,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new InvalidLaunchPayloadError(path);
  }
  return value as number;
}

function readNullableInteger(
  record: Record<string, unknown>,
  field: string,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return record[field] === null ? null : readInteger(record, field, path, minimum, maximum);
}

function readNullableText(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
): string | null {
  return record[field] === null ? null : readText(record, field, path, maximum);
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  path: string,
  values: readonly T[],
): T {
  const value = record[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new InvalidLaunchPayloadError(path);
  }
  return value as T;
}

function readArray(
  record: Record<string, unknown>,
  field: string,
  path: string,
  maximum: number,
): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new InvalidLaunchPayloadError(path);
  }
  return value;
}

function decodeStringList(value: unknown, path: string, maximum = 64): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new InvalidLaunchPayloadError(path);
  }
  const values = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new InvalidLaunchPayloadError(`${path}.${index}`);
    }
    return readText({ value: entry }, "value", `${path}.${index}`, 768);
  });
  if (new Set(values).size !== values.length) {
    throw new InvalidLaunchPayloadError(path);
  }
  return values;
}

function decodeModelRoles(
  value: unknown,
  path: string,
): Readonly<Partial<Record<LaunchModelRole, string>>> {
  if (!isRecord(value) || Object.keys(value).length > launchModelRoles.length) {
    throw new InvalidLaunchPayloadError(path);
  }
  const roles: Partial<Record<LaunchModelRole, string>> = {};
  for (const [role, selector] of Object.entries(value)) {
    if (!launchModelRoles.includes(role as LaunchModelRole) || typeof selector !== "string") {
      throw new InvalidLaunchPayloadError(`${path}.${role}`);
    }
    roles[role as LaunchModelRole] = readText({ selector }, "selector", `${path}.${role}`, 768);
  }
  return roles;
}

function decodeSources(
  value: unknown,
  path: string,
): Readonly<Record<string, LaunchSettingSource>> {
  if (!isRecord(value) || Object.keys(value).length > 32) {
    throw new InvalidLaunchPayloadError(path);
  }
  const sources: Record<string, LaunchSettingSource> = {};
  for (const [key, source] of Object.entries(value)) {
    const safeKey = readText({ key }, "key", `${path}.key`, 128);
    if (
      typeof source !== "string" ||
      !launchSettingSources.includes(source as LaunchSettingSource)
    ) {
      throw new InvalidLaunchPayloadError(`${path}.${key}`);
    }
    sources[safeKey] = source as LaunchSettingSource;
  }
  return sources;
}

function decodeCredentialPolicy(value: unknown, path: string): "automatic" | "profile" {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new InvalidLaunchPayloadError(path);
  }
  const kind = value.kind;
  if (kind !== "automatic" && kind !== "profile") {
    throw new InvalidLaunchPayloadError(`${path}.kind`);
  }
  return kind;
}

function decodeModel(value: unknown, index: number): LaunchModel {
  const path = `available_models.${index}`;
  if (!isRecord(value) || typeof value.reasoning !== "boolean") {
    throw new InvalidLaunchPayloadError(path);
  }
  const provider = readText(value, "provider", `${path}.provider`, 128);
  const id = readText(value, "id", `${path}.id`, 512);
  const selector = readText(value, "selector", `${path}.selector`, 768);
  if (selector !== `${provider}/${id}`) {
    throw new InvalidLaunchPayloadError(`${path}.selector`);
  }
  return {
    provider,
    id,
    selector,
    name: readText(value, "name", `${path}.name`, 512),
    context_window: readNullableInteger(value, "context_window", `${path}.context_window`),
    max_tokens: readNullableInteger(value, "max_tokens", `${path}.max_tokens`),
    reasoning: value.reasoning,
    thinking: decodeStringList(value.thinking, `${path}.thinking`, 32),
    input: decodeStringList(value.input, `${path}.input`, 16),
  };
}

function verifyScope(
  record: Record<string, unknown>,
  expected: LaunchScope,
  path: string,
): {
  readonly projectId: number;
  readonly bindingRevision: number;
  readonly action: LaunchAction;
  readonly sessionIndexId: number | null;
} {
  const projectId = readInteger(record, "project_id", `${path}.project_id`, 1);
  const bindingRevision = readInteger(record, "binding_revision", `${path}.binding_revision`, 1);
  const action = readEnum(record, "action", `${path}.action`, launchActions);
  const sessionIndexId = readNullableInteger(
    record,
    "session_index_id",
    `${path}.session_index_id`,
    1,
  );
  if (
    projectId !== expected.projectId ||
    bindingRevision !== expected.bindingRevision ||
    action !== expected.action ||
    sessionIndexId !== expected.sessionIndexId
  ) {
    throw new InvalidLaunchPayloadError(`${path}.scope`);
  }
  return { projectId, bindingRevision, action, sessionIndexId };
}

function decodeSharedLaunchFields(
  value: Record<string, unknown>,
  path: string,
): Omit<
  LaunchOptions,
  "project_id" | "binding_revision" | "action" | "session_index_id" | "available_models"
> {
  const thinking =
    value.thinking_level === null
      ? null
      : readEnum(value, "thinking_level", `${path}.thinking_level`, thinkingLevels);
  return {
    session_id: readNullableText(value, "session_id", `${path}.session_id`, 256),
    profile: readText(value, "profile", `${path}.profile`, 64),
    cwd_display: readText(value, "cwd_display", `${path}.cwd_display`, 32_768),
    model_roles: decodeModelRoles(value.model_roles, `${path}.model_roles`),
    thinking_level: thinking,
    credential_policy: decodeCredentialPolicy(value.credential_policy, `${path}.credential_policy`),
    terminal_mode: readEnum(value, "terminal_mode", `${path}.terminal_mode`, launchTerminalModes),
    warnings: decodeStringList(value.warnings, `${path}.warnings`, 64),
    setting_sources: decodeSources(value.setting_sources, `${path}.setting_sources`),
  };
}

export function decodeLaunchOptions(value: unknown, expected: LaunchScope): LaunchOptions {
  if (!isRecord(value)) {
    throw new InvalidLaunchPayloadError("options");
  }
  const scope = verifyScope(value, expected, "options");
  const availableModels = readArray(
    value,
    "available_models",
    "options.available_models",
    4_096,
  ).map(decodeModel);
  if (new Set(availableModels.map((model) => model.selector)).size !== availableModels.length) {
    throw new InvalidLaunchPayloadError("options.available_models");
  }
  const shared = decodeSharedLaunchFields(value, "options");
  if ((expected.action === "resume") !== (shared.session_id !== null)) {
    throw new InvalidLaunchPayloadError("options.session_id");
  }
  return {
    project_id: scope.projectId,
    binding_revision: scope.bindingRevision,
    action: scope.action,
    session_index_id: scope.sessionIndexId,
    available_models: availableModels,
    ...shared,
  };
}

export function decodePreparedLaunch(
  value: unknown,
  expected: PrepareLaunchInput,
): PreparedLaunchPlan {
  if (!isRecord(value)) {
    throw new InvalidLaunchPayloadError("plan");
  }
  const scope = verifyScope(value, expected, "plan");
  const shared = decodeSharedLaunchFields(value, "plan");
  for (const role of launchModelRoles) {
    if ((shared.model_roles[role] ?? null) !== (expected.modelRoles[role] ?? null)) {
      throw new InvalidLaunchPayloadError(`plan.model_roles.${role}`);
    }
  }
  if (shared.thinking_level !== expected.thinkingLevel) {
    throw new InvalidLaunchPayloadError("plan.thinking_level");
  }
  const created = readInteger(
    value,
    "created_at_epoch_ms",
    "plan.created_at_epoch_ms",
    0,
    MAX_TIMESTAMP,
  );
  const expires = readInteger(
    value,
    "expires_at_epoch_ms",
    "plan.expires_at_epoch_ms",
    created,
    MAX_TIMESTAMP,
  );
  if (expires - created > 5 * 60_000) {
    throw new InvalidLaunchPayloadError("plan.expires_at_epoch_ms");
  }
  const environment = readArray(value, "environment", "plan.environment", 128).map(
    (entry, index): LaunchEnvironmentSummary => {
      const path = `plan.environment.${index}`;
      if (
        !isRecord(entry) ||
        Object.keys(entry).length !== 3 ||
        entry.source !== "manager_process" ||
        typeof entry.present !== "boolean"
      ) {
        throw new InvalidLaunchPayloadError(path);
      }
      const name = readText(entry, "name", `${path}.name`, 128);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new InvalidLaunchPayloadError(`${path}.name`);
      }
      return { name, source: "manager_process", present: entry.present };
    },
  );
  if (new Set(environment.map((entry) => entry.name)).size !== environment.length) {
    throw new InvalidLaunchPayloadError("plan.environment");
  }
  return {
    plan_id: readText(value, "plan_id", "plan.plan_id", 64),
    input_fingerprint: readText(value, "input_fingerprint", "plan.input_fingerprint", 128),
    created_at_epoch_ms: created,
    expires_at_epoch_ms: expires,
    project_id: scope.projectId,
    binding_revision: scope.bindingRevision,
    action: scope.action,
    session_index_id: scope.sessionIndexId,
    display_preview_redacted: readText(
      value,
      "display_preview_redacted",
      "plan.display_preview_redacted",
      4_096,
    ),
    environment,
    ...shared,
  };
}

export function decodePtyRun(value: unknown, expectedRunId?: string): PtyRunSnapshot {
  if (!isRecord(value) || typeof value.output_truncated !== "boolean") {
    throw new InvalidLaunchPayloadError("run");
  }
  const runId = readText(value, "run_id", "run.run_id", 64);
  if (!UUID_PATTERN.test(runId) || (expectedRunId !== undefined && runId !== expectedRunId)) {
    throw new InvalidLaunchPayloadError("run.run_id");
  }
  const first = readInteger(value, "first_available_sequence", "run.first_available_sequence", 1);
  const last = readInteger(value, "last_sequence", "run.last_sequence", 0);
  if (first > last + 1) {
    throw new InvalidLaunchPayloadError("run.sequence");
  }
  const action = readEnum(value, "action", "run.action", launchActions);
  const sessionId = readNullableText(value, "session_id", "run.session_id", 256);
  const status = readEnum(value, "status", "run.status", terminalRunStatuses);
  const startedAt = readInteger(
    value,
    "started_at_epoch_ms",
    "run.started_at_epoch_ms",
    0,
    MAX_TIMESTAMP,
  );
  const finishedAt = readNullableInteger(
    value,
    "finished_at_epoch_ms",
    "run.finished_at_epoch_ms",
    0,
    MAX_TIMESTAMP,
  );
  const exitCode = readNullableInteger(value, "exit_code", "run.exit_code", 0, 0xffff_ffff);
  const signal = readNullableText(value, "signal", "run.signal", 256);
  if (
    (action === "new") !== (sessionId === null) ||
    (status === "running" && (finishedAt !== null || exitCode !== null || signal !== null)) ||
    (status !== "running" && (finishedAt === null || finishedAt < startedAt))
  ) {
    throw new InvalidLaunchPayloadError("run.state");
  }
  return {
    run_id: runId,
    project_id: readInteger(value, "project_id", "run.project_id", 1),
    action,
    session_id: sessionId,
    title: readText(value, "title", "run.title", 32_768),
    profile: readText(value, "profile", "run.profile", 64),
    model_roles: decodeModelRoles(value.model_roles, "run.model_roles"),
    thinking_level:
      value.thinking_level === null
        ? null
        : readEnum(value, "thinking_level", "run.thinking_level", thinkingLevels),
    status,
    process_id: readNullableInteger(value, "process_id", "run.process_id", 1, 0xffff_ffff),
    started_at_epoch_ms: startedAt,
    finished_at_epoch_ms: finishedAt,
    exit_code: exitCode,
    signal,
    rows: readInteger(value, "rows", "run.rows", 2, 500),
    cols: readInteger(value, "cols", "run.cols", 2, 500),
    first_available_sequence: first,
    last_sequence: last,
    output_truncated: value.output_truncated,
  };
}

export function decodeLaunchExecution(
  value: unknown,
  expected: PreparedLaunchPlan,
): LaunchExecutionResult {
  if (!isRecord(value)) {
    throw new InvalidLaunchPayloadError("execution");
  }
  const kind = readEnum(value, "kind", "execution.kind", ["embedded", "external"] as const);
  if (kind === "embedded") {
    const run = decodePtyRun(value.run);
    verifyExecutionScope(run, expected, "execution.run");
    return { kind, run };
  }
  if (!isRecord(value.launch)) {
    throw new InvalidLaunchPayloadError("execution.launch");
  }
  const launch = value.launch;
  const terminalId = readText(launch, "terminal_id", "execution.launch.terminal_id", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(terminalId)) {
    throw new InvalidLaunchPayloadError("execution.launch.terminal_id");
  }
  const result: ExternalTerminalLaunch = {
    terminal_id: terminalId,
    process_id: readNullableInteger(
      launch,
      "process_id",
      "execution.launch.process_id",
      1,
      0xffff_ffff,
    ),
    project_id: readInteger(launch, "project_id", "execution.launch.project_id", 1),
    action: readEnum(launch, "action", "execution.launch.action", launchActions),
    session_id: readNullableText(launch, "session_id", "execution.launch.session_id", 256),
    profile: readText(launch, "profile", "execution.launch.profile", 64),
    model_roles: decodeModelRoles(launch.model_roles, "execution.launch.model_roles"),
    thinking_level:
      launch.thinking_level === null
        ? null
        : readEnum(launch, "thinking_level", "execution.launch.thinking_level", thinkingLevels),
    launched_at_epoch_ms: readInteger(
      launch,
      "launched_at_epoch_ms",
      "execution.launch.launched_at_epoch_ms",
      expected.created_at_epoch_ms,
      MAX_TIMESTAMP,
    ),
  };
  verifyExecutionScope(result, expected, "execution.launch");
  return { kind, launch: result };
}

function verifyExecutionScope(
  actual: Pick<
    PtyRunSnapshot | ExternalTerminalLaunch,
    "project_id" | "action" | "session_id" | "profile" | "model_roles" | "thinking_level"
  >,
  expected: PreparedLaunchPlan,
  path: string,
): void {
  if (
    actual.project_id !== expected.project_id ||
    actual.action !== expected.action ||
    actual.session_id !== expected.session_id ||
    actual.profile !== expected.profile ||
    actual.thinking_level !== expected.thinking_level ||
    launchModelRoles.some(
      (role) => (actual.model_roles[role] ?? null) !== (expected.model_roles[role] ?? null),
    )
  ) {
    throw new InvalidLaunchPayloadError(`${path}.scope`);
  }
}

export function decodePtyOutputFrame(value: unknown, expectedRunId: string): PtyOutputFrame {
  if (!isRecord(value)) {
    throw new InvalidLaunchPayloadError("frame");
  }
  const runId = readText(value, "run_id", "frame.run_id", 64);
  if (runId !== expectedRunId) {
    throw new InvalidLaunchPayloadError("frame.run_id");
  }
  const bytes = readArray(value, "bytes", "frame.bytes", 8 * 1_024).map((byte, index) => {
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255) {
      throw new InvalidLaunchPayloadError(`frame.bytes.${index}`);
    }
    return byte as number;
  });
  return {
    run_id: runId,
    sequence: readInteger(value, "sequence", "frame.sequence", 1),
    bytes: Uint8Array.from(bytes),
  };
}

export function decodePtyOutputBatch(value: unknown, expectedRunId: string): PtyOutputBatch {
  if (!isRecord(value) || typeof value.gap_before_first_frame !== "boolean") {
    throw new InvalidLaunchPayloadError("batch");
  }
  const run = decodePtyRun(value.run, expectedRunId);
  const frames = readArray(value, "frames", "batch.frames", 256).map((frame) =>
    decodePtyOutputFrame(frame, expectedRunId),
  );
  let previous = 0;
  for (const frame of frames) {
    if (frame.sequence <= previous || frame.sequence > run.last_sequence) {
      throw new InvalidLaunchPayloadError("batch.frames.sequence");
    }
    previous = frame.sequence;
  }
  return { run, frames, gap_before_first_frame: value.gap_before_first_frame };
}

function decodeDiagnostic(value: unknown): ProbeDiagnostic {
  if (!isRecord(value) || typeof value.retryable !== "boolean") {
    throw new InvalidLaunchPayloadError("diagnostic");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 5 ||
    !fields.every((field) =>
      ["code", "message", "suggestion", "retryable", "technical_detail_redacted"].includes(field),
    )
  ) {
    throw new InvalidLaunchPayloadError("diagnostic");
  }
  return {
    code: readText(value, "code", "diagnostic.code", 160),
    message: readText(value, "message", "diagnostic.message", 2_000),
    suggestion: readText(value, "suggestion", "diagnostic.suggestion", 2_000, true),
    retryable: value.retryable,
    technical_detail_redacted: readText(
      value,
      "technical_detail_redacted",
      "diagnostic.technical_detail_redacted",
      4_000,
      true,
    ),
  };
}

export function classifyLaunchFailure(error: unknown): LaunchFailure {
  if (error instanceof InvalidLaunchPayloadError) {
    return { kind: "invalid_payload" };
  }
  try {
    return { kind: "backend", diagnostic: decodeDiagnostic(error) };
  } catch {
    return { kind: "invoke_failed" };
  }
}
