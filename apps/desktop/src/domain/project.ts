import { sanitizeWireText, type ProbeDiagnostic } from "./probe";

export const terminalModes = ["embedded", "external"] as const;
export type TerminalMode = (typeof terminalModes)[number];

export const accountPolicies = ["automatic", "profile", "credential_pin"] as const;
export type AccountPolicy = (typeof accountPolicies)[number];

export const settingSources = [
  "launch_override",
  "session",
  "project",
  "profile",
  "global",
] as const;
export type SettingSource = (typeof settingSources)[number];

export const authorizationStatuses = [
  "active",
  "offline",
  "replaced",
  "revoked",
  "missing",
] as const;
export type AuthorizationStatus = (typeof authorizationStatuses)[number];
export const projectAuthorizationStatuses = authorizationStatuses;
export type ProjectAuthorizationStatus = AuthorizationStatus;
export type ExternalEditorId = "cursor";

export const knownProfileSources = ["default", "project_binding"] as const;
export type KnownProfileSource = (typeof knownProfileSources)[number];

export interface ProjectGitIdentity {
  readonly common_directory: string;
  readonly repository_relative_path: string;
}

export interface ProjectBinding {
  readonly id: number;
  readonly revision: number;
  readonly path_prefix: string;
  readonly profile: string;
  readonly profile_source: SettingSource;
  readonly terminal_mode: TerminalMode;
  readonly terminal_mode_source: SettingSource;
  readonly account_policy: AccountPolicy;
  readonly account_policy_source: SettingSource;
  readonly role_defaults: Readonly<Record<string, string>>;
  readonly allowed_models: readonly string[];
  readonly disabled_providers: readonly string[];
  readonly updated_at_epoch_ms: number;
}

export interface ProjectSummary {
  readonly id: number;
  readonly target_id: string;
  readonly canonical_path: string;
  readonly display_path: string;
  readonly git_identity: ProjectGitIdentity | null;
  readonly created_at_epoch_ms: number;
  readonly last_used_at_epoch_ms: number;
  readonly authorization_status: AuthorizationStatus;
  readonly binding: ProjectBinding;
}

export interface KnownProfile {
  readonly name: string;
  readonly source: KnownProfileSource;
  readonly agent_directory: string | null;
  readonly is_complete_inventory: boolean;
}

export interface ProjectWorkspace {
  readonly projects: readonly ProjectSummary[];
  readonly known_profiles: readonly KnownProfile[];
}

/** The M1 UI only exposes capabilities that are implemented end-to-end. */
export interface ProjectBindingDraft {
  readonly profile: string;
  readonly terminal_mode: "embedded";
  readonly account_policy: "automatic" | "profile";
}

export interface UpdateProjectBindingRequest extends ProjectBindingDraft {
  readonly project_id: number;
  readonly expected_revision: number;
}

export interface OpenProjectInEditorRequest {
  readonly project_id: number;
  readonly editor_id: ExternalEditorId;
}

export interface OpenProjectInEditorResult {
  readonly project_id: number;
  readonly editor_id: ExternalEditorId;
  readonly process_id: number | null;
}

export interface AddProjectResult {
  readonly project: ProjectSummary;
  readonly diagnostics: readonly ProbeDiagnostic[];
}

export type ProjectFailure =
  | { readonly kind: "invalid_payload" }
  | { readonly kind: "invoke_failed" }
  | { readonly kind: "backend"; readonly diagnostic: ProbeDiagnostic };

const MAX_PROJECTS = 512;
const MAX_KNOWN_PROFILES = 513;
const MAX_ROLE_DEFAULTS = 64;
const MAX_ALLOWED_MODELS = 512;
const MAX_DISABLED_PROVIDERS = 512;
const MAX_DIAGNOSTICS = 100;
const MAX_PATH_TEXT = 32_768;
const MAX_SETTING_TEXT = 2_048;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export class InvalidProjectPayloadError extends Error {
  public constructor(field: string) {
    super(`Invalid project payload field: ${field}`);
    this.name = "InvalidProjectPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(
  record: Record<string, unknown>,
  field: string,
  path: string,
  options: { readonly allowEmpty?: boolean; readonly maximumLength?: number } = {},
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new InvalidProjectPayloadError(path);
  }

  const text = sanitizeWireText(value, options.maximumLength ?? 2_000);
  if (options.allowEmpty !== true && text.trim().length === 0) {
    throw new InvalidProjectPayloadError(path);
  }
  return text;
}

function readBoolean(record: Record<string, unknown>, field: string, path: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new InvalidProjectPayloadError(path);
  }
  return value;
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
    throw new InvalidProjectPayloadError(path);
  }
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  path: string,
  values: readonly T[],
): T {
  const value = record[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new InvalidProjectPayloadError(path);
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
    throw new InvalidProjectPayloadError(path);
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
      throw new InvalidProjectPayloadError(`${path}.${index}`);
    }
    const text = sanitizeWireText(value, maximumTextLength);
    if (text.trim().length === 0) {
      throw new InvalidProjectPayloadError(`${path}.${index}`);
    }
    return text;
  });
  if (new Set(values).size !== values.length) {
    throw new InvalidProjectPayloadError(path);
  }
  return values;
}

function decodeDiagnostic(
  value: unknown,
  path: string,
  requireExactShape = false,
): ProbeDiagnostic {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError(path);
  }
  if (
    requireExactShape &&
    (Object.keys(value).length !== 5 ||
      !Object.keys(value).every((field) =>
        ["code", "message", "suggestion", "retryable", "technical_detail_redacted"].includes(field),
      ))
  ) {
    throw new InvalidProjectPayloadError(path);
  }
  return {
    code: readText(value, "code", `${path}.code`, { maximumLength: 160 }),
    message: readText(value, "message", `${path}.message`, { maximumLength: 2_000 }),
    suggestion: readText(value, "suggestion", `${path}.suggestion`, {
      allowEmpty: true,
      maximumLength: 2_000,
    }),
    retryable: readBoolean(value, "retryable", `${path}.retryable`),
    technical_detail_redacted: readText(
      value,
      "technical_detail_redacted",
      `${path}.technical_detail_redacted`,
      { allowEmpty: true, maximumLength: 4_000 },
    ),
  };
}

function decodeGitIdentity(value: unknown, path: string): ProjectGitIdentity | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError(path);
  }
  return {
    common_directory: readText(value, "common_directory", `${path}.common_directory`, {
      maximumLength: MAX_PATH_TEXT,
    }),
    repository_relative_path: readText(
      value,
      "repository_relative_path",
      `${path}.repository_relative_path`,
      { allowEmpty: true, maximumLength: MAX_PATH_TEXT },
    ),
  };
}

function decodeRoleDefaults(value: unknown, path: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError(path);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ROLE_DEFAULTS) {
    throw new InvalidProjectPayloadError(path);
  }

  const decodedEntries = entries.map(([rawRole, rawModel]) => {
    const role = sanitizeWireText(rawRole, MAX_SETTING_TEXT);
    if (role.trim().length === 0 || typeof rawModel !== "string") {
      throw new InvalidProjectPayloadError(path);
    }
    const model = sanitizeWireText(rawModel, MAX_SETTING_TEXT);
    if (model.trim().length === 0) {
      throw new InvalidProjectPayloadError(`${path}.${role}`);
    }
    return [role, model];
  });
  if (new Set(decodedEntries.map(([role]) => role)).size !== decodedEntries.length) {
    throw new InvalidProjectPayloadError(path);
  }
  return Object.fromEntries(decodedEntries);
}

function decodeProjectBinding(value: unknown, path: string): ProjectBinding {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError(path);
  }
  return {
    id: readInteger(value, "id", `${path}.id`, 1),
    revision: readInteger(value, "revision", `${path}.revision`, 1),
    path_prefix: readText(value, "path_prefix", `${path}.path_prefix`, {
      maximumLength: MAX_PATH_TEXT,
    }),
    profile: readText(value, "profile", `${path}.profile`, { maximumLength: 64 }),
    profile_source: readEnum(value, "profile_source", `${path}.profile_source`, settingSources),
    terminal_mode: readEnum(value, "terminal_mode", `${path}.terminal_mode`, terminalModes),
    terminal_mode_source: readEnum(
      value,
      "terminal_mode_source",
      `${path}.terminal_mode_source`,
      settingSources,
    ),
    account_policy: readEnum(value, "account_policy", `${path}.account_policy`, accountPolicies),
    account_policy_source: readEnum(
      value,
      "account_policy_source",
      `${path}.account_policy_source`,
      settingSources,
    ),
    role_defaults: decodeRoleDefaults(value.role_defaults, `${path}.role_defaults`),
    allowed_models: readUniqueTextArray(
      value,
      "allowed_models",
      `${path}.allowed_models`,
      MAX_ALLOWED_MODELS,
      MAX_SETTING_TEXT,
    ),
    disabled_providers: readUniqueTextArray(
      value,
      "disabled_providers",
      `${path}.disabled_providers`,
      MAX_DISABLED_PROVIDERS,
      MAX_SETTING_TEXT,
    ),
    updated_at_epoch_ms: readInteger(
      value,
      "updated_at_epoch_ms",
      `${path}.updated_at_epoch_ms`,
      0,
      MAX_TIMESTAMP,
    ),
  };
}

function decodeKnownProfile(value: unknown, path: string): KnownProfile {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError(path);
  }
  const agentDirectory = value.agent_directory;
  if (agentDirectory !== null && typeof agentDirectory !== "string") {
    throw new InvalidProjectPayloadError(`${path}.agent_directory`);
  }
  const isCompleteInventory = readBoolean(
    value,
    "is_complete_inventory",
    `${path}.is_complete_inventory`,
  );
  if (isCompleteInventory) {
    throw new InvalidProjectPayloadError(`${path}.is_complete_inventory`);
  }

  return {
    name: readText(value, "name", `${path}.name`, { maximumLength: 64 }),
    source: readEnum(value, "source", `${path}.source`, knownProfileSources),
    agent_directory:
      agentDirectory === null
        ? null
        : readText(value, "agent_directory", `${path}.agent_directory`, {
            maximumLength: MAX_PATH_TEXT,
          }),
    is_complete_inventory: false,
  };
}

export function decodeProjectSummary(value: unknown): ProjectSummary {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError("project");
  }
  const project: ProjectSummary = {
    id: readInteger(value, "id", "project.id", 1),
    target_id: readText(value, "target_id", "project.target_id", { maximumLength: 160 }),
    canonical_path: readText(value, "canonical_path", "project.canonical_path", {
      maximumLength: MAX_PATH_TEXT,
    }),
    display_path: readText(value, "display_path", "project.display_path", {
      maximumLength: MAX_PATH_TEXT,
    }),
    git_identity: decodeGitIdentity(value.git_identity, "project.git_identity"),
    created_at_epoch_ms: readInteger(
      value,
      "created_at_epoch_ms",
      "project.created_at_epoch_ms",
      0,
      MAX_TIMESTAMP,
    ),
    last_used_at_epoch_ms: readInteger(
      value,
      "last_used_at_epoch_ms",
      "project.last_used_at_epoch_ms",
      0,
      MAX_TIMESTAMP,
    ),
    authorization_status: readEnum(
      value,
      "authorization_status",
      "project.authorization_status",
      authorizationStatuses,
    ),
    binding: decodeProjectBinding(value.binding, "project.binding"),
  };

  if (project.last_used_at_epoch_ms < project.created_at_epoch_ms) {
    throw new InvalidProjectPayloadError("project.timestamps");
  }
  return project;
}

export function decodeProjectWorkspace(value: unknown): ProjectWorkspace {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError("root");
  }

  const projects = readArray(value, "projects", "projects", MAX_PROJECTS).map((project) =>
    decodeProjectSummary(project),
  );
  const knownProfiles = readArray(
    value,
    "known_profiles",
    "known_profiles",
    MAX_KNOWN_PROFILES,
  ).map((profile, index) => decodeKnownProfile(profile, `known_profiles.${index}`));

  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new InvalidProjectPayloadError("projects.id");
  }
  if (new Set(projects.map((project) => project.binding.id)).size !== projects.length) {
    throw new InvalidProjectPayloadError("projects.binding.id");
  }
  if (
    new Set(projects.map((project) => `${project.target_id}\u0000${project.canonical_path}`))
      .size !== projects.length
  ) {
    throw new InvalidProjectPayloadError("projects.identity");
  }
  if (new Set(knownProfiles.map((profile) => profile.name)).size !== knownProfiles.length) {
    throw new InvalidProjectPayloadError("known_profiles.name");
  }

  return { projects, known_profiles: knownProfiles };
}

export function decodeAddProjectResult(value: unknown): AddProjectResult {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError("root");
  }
  return {
    project: decodeProjectSummary(value.project),
    diagnostics: readArray(value, "diagnostics", "diagnostics", MAX_DIAGNOSTICS).map(
      (diagnostic, index) => decodeDiagnostic(diagnostic, `diagnostics.${index}`),
    ),
  };
}

export function decodeOpenProjectInEditorResult(value: unknown): OpenProjectInEditorResult {
  if (!isRecord(value)) {
    throw new InvalidProjectPayloadError("editor_result");
  }
  if (value.editor_id !== "cursor") {
    throw new InvalidProjectPayloadError("editor_result.editor_id");
  }
  const processId =
    value.process_id === null
      ? null
      : readInteger(value, "process_id", "editor_result.process_id", 1, 4_294_967_295);
  return {
    project_id: readInteger(value, "project_id", "editor_result.project_id", 1),
    editor_id: "cursor",
    process_id: processId,
  };
}

export function classifyProjectFailure(error: unknown): ProjectFailure {
  if (error instanceof InvalidProjectPayloadError) {
    return { kind: "invalid_payload" };
  }
  try {
    return { kind: "backend", diagnostic: decodeDiagnostic(error, "error", true) };
  } catch {
    return { kind: "invoke_failed" };
  }
}
