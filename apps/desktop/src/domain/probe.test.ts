import { describe, expect, it } from "vitest";

import {
  decodeProbeReport,
  InvalidProbePayloadError,
  mapProbeStateToView,
  type ProbeReport,
} from "./probe";

function report(status: ProbeReport["status"]): ProbeReport {
  return {
    target_id: "local",
    status,
    installation:
      status === "missing"
        ? null
        : {
            executable_path: "/usr/bin/omp",
            version: "1.0.0",
            architecture: "x86_64",
            probed_at_epoch_ms: 1_700_000_000_000,
            binary_modified_at_epoch_ms: null,
          },
    capabilities: [],
    diagnostics: [],
  };
}

function wireReport(): Record<string, unknown> {
  return {
    target_id: "local",
    status: "ready",
    installation: {
      executable_path: "/usr/bin/omp",
      version: "1.0.0",
      architecture: "x86_64",
      probed_at_epoch_ms: 1_700_000_000_000,
      binary_modified_at_epoch_ms: null,
    },
    capabilities: [
      {
        id: "future_capability",
        available: true,
        source: "cli",
        evidence: "verified",
      },
    ],
    diagnostics: [],
  };
}

describe("probe state presentation", () => {
  it.each([
    [{ phase: "loading" } as const, "loading"],
    [{ phase: "resolved", report: report("missing") } as const, "missing"],
    [{ phase: "resolved", report: report("ready") } as const, "ready"],
    [{ phase: "resolved", report: report("limited") } as const, "limited"],
    [{ phase: "failed", code: "invoke_failed", diagnostic: null } as const, "error"],
    [{ phase: "failed", code: "operation_timed_out", diagnostic: null } as const, "error"],
  ])("maps %j to %s", (state, expected) => {
    expect(mapProbeStateToView(state)).toBe(expected);
  });
});

describe("probe report decoder", () => {
  it("accepts the stable snake_case contract and unknown capability ids", () => {
    const decoded = decodeProbeReport(wireReport());
    expect(decoded.status).toBe("ready");
    expect(decoded.capabilities[0]?.id).toBe("future_capability");
  });

  it("removes display-spoofing control characters from backend text", () => {
    const value = wireReport();
    value.target_id = "local\u202Ehidden";
    expect(decodeProbeReport(value).target_id).toBe("local�hidden");
  });

  it("rejects impossible installation/status combinations", () => {
    const value = wireReport();
    value.status = "missing";
    expect(() => decodeProbeReport(value)).toThrow(InvalidProbePayloadError);
  });

  it("rejects unknown capability sources instead of guessing", () => {
    const value = wireReport();
    value.capabilities = [
      {
        id: "models_json",
        available: true,
        source: "untrusted_source",
        evidence: "unknown",
      },
    ];
    expect(() => decodeProbeReport(value)).toThrow(InvalidProbePayloadError);
  });
});
