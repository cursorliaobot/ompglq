export const probeStatuses = ["missing", "ready", "limited"] as const;
export type ProbeStatus = (typeof probeStatuses)[number];

export const capabilitySources = [
  "cli",
  "broker",
  "gateway",
  "interactive",
  "unavailable",
] as const;
export type CapabilitySource = (typeof capabilitySources)[number];

export interface OmpInstallation {
  readonly executable_path: string;
  readonly version: string;
  readonly architecture: string;
  readonly probed_at_epoch_ms: number;
  readonly binary_modified_at_epoch_ms: number | null;
}

export interface OmpCapability {
  readonly id: string;
  readonly available: boolean;
  readonly source: CapabilitySource;
  readonly evidence: string;
}

export interface ProbeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly technical_detail_redacted: string;
}

export interface ProbeReport {
  readonly target_id: string;
  readonly status: ProbeStatus;
  readonly installation: OmpInstallation | null;
  readonly capabilities: readonly OmpCapability[];
  readonly diagnostics: readonly ProbeDiagnostic[];
}

export type ProbeFailureCode =
  | "invoke_failed"
  | "invalid_payload"
  | "operation_failed"
  | "operation_timed_out"
  | "operation_interrupted";

export type ProbeMachineState =
  | { readonly phase: "loading" }
  | { readonly phase: "resolved"; readonly report: ProbeReport }
  | {
      readonly phase: "failed";
      readonly code: ProbeFailureCode;
      readonly diagnostic: ProbeDiagnostic | null;
    };

export type ProbeViewState = "loading" | "missing" | "ready" | "limited" | "error";

const MAX_CAPABILITIES = 128;
const MAX_DIAGNOSTICS = 100;
const BIDI_CONTROL_CHARACTERS = /[\u202a-\u202e\u2066-\u2069]/gu;
// Explicit C0 ranges are the wire sanitization policy, not user-supplied syntax.
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export class InvalidProbePayloadError extends Error {
  public constructor(field: string) {
    super(`Invalid probe payload field: ${field}`);
    this.name = "InvalidProbePayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps backend-controlled text inert and bounded before it reaches the view.
 * React performs HTML escaping; this additionally removes control characters
 * that can spoof or disrupt diagnostic output.
 */
export function sanitizeWireText(value: string, maxLength = 2_000): string {
  return value
    .replace(UNSAFE_CONTROL_CHARACTERS, "�")
    .replace(BIDI_CONTROL_CHARACTERS, "�")
    .slice(0, maxLength);
}

function readText(
  record: Record<string, unknown>,
  field: string,
  options: { readonly maxLength?: number; readonly allowEmpty?: boolean } = {},
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new InvalidProbePayloadError(field);
  }

  const result = sanitizeWireText(value, options.maxLength);
  if (options.allowEmpty !== true && result.trim().length === 0) {
    throw new InvalidProbePayloadError(field);
  }
  return result;
}

function readBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new InvalidProbePayloadError(field);
  }
  return value;
}

function readTimestamp(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new InvalidProbePayloadError(field);
  }
  return value;
}

function readNullableTimestamp(record: Record<string, unknown>, field: string): number | null {
  if (record[field] === null) {
    return null;
  }
  return readTimestamp(record, field);
}

function parseInstallation(value: unknown): OmpInstallation | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new InvalidProbePayloadError("installation");
  }
  return {
    executable_path: readText(value, "executable_path", { maxLength: 4_096 }),
    version: readText(value, "version", { maxLength: 128 }),
    architecture: readText(value, "architecture", { maxLength: 128 }),
    probed_at_epoch_ms: readTimestamp(value, "probed_at_epoch_ms"),
    binary_modified_at_epoch_ms: readNullableTimestamp(value, "binary_modified_at_epoch_ms"),
  };
}

function parseCapability(value: unknown, index: number): OmpCapability {
  if (!isRecord(value)) {
    throw new InvalidProbePayloadError(`capabilities.${index}`);
  }

  const source = value.source;
  if (typeof source !== "string" || !capabilitySources.includes(source as CapabilitySource)) {
    throw new InvalidProbePayloadError(`capabilities.${index}.source`);
  }

  return {
    id: readText(value, "id", { maxLength: 160 }),
    available: readBoolean(value, "available"),
    source: source as CapabilitySource,
    evidence: readText(value, "evidence", { allowEmpty: true, maxLength: 2_000 }),
  };
}

function parseDiagnostic(value: unknown, index: number): ProbeDiagnostic {
  if (!isRecord(value)) {
    throw new InvalidProbePayloadError(`diagnostics.${index}`);
  }

  return {
    code: readText(value, "code", { maxLength: 160 }),
    message: readText(value, "message", { maxLength: 2_000 }),
    suggestion: readText(value, "suggestion", { allowEmpty: true, maxLength: 2_000 }),
    retryable: readBoolean(value, "retryable"),
    technical_detail_redacted: readText(value, "technical_detail_redacted", {
      allowEmpty: true,
      maxLength: 4_000,
    }),
  };
}

function readArray(
  record: Record<string, unknown>,
  field: string,
  maximumLength: number,
): readonly unknown[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new InvalidProbePayloadError(field);
  }
  return value;
}

export function decodeProbeReport(value: unknown): ProbeReport {
  if (!isRecord(value)) {
    throw new InvalidProbePayloadError("root");
  }

  const status = value.status;
  if (typeof status !== "string" || !probeStatuses.includes(status as ProbeStatus)) {
    throw new InvalidProbePayloadError("status");
  }

  const installation = parseInstallation(value.installation);
  if ((status === "ready" || status === "limited") && installation === null) {
    throw new InvalidProbePayloadError("installation");
  }
  if (status === "missing" && installation !== null) {
    throw new InvalidProbePayloadError("installation");
  }

  return {
    target_id: readText(value, "target_id", { maxLength: 160 }),
    status: status as ProbeStatus,
    installation,
    capabilities: readArray(value, "capabilities", MAX_CAPABILITIES).map(parseCapability),
    diagnostics: readArray(value, "diagnostics", MAX_DIAGNOSTICS).map(parseDiagnostic),
  };
}

export function mapProbeStateToView(state: ProbeMachineState): ProbeViewState {
  switch (state.phase) {
    case "loading":
      return "loading";
    case "failed":
      return "error";
    case "resolved":
      return state.report.status;
  }
}
