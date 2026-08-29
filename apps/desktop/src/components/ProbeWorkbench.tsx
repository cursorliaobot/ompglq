import type { ReactNode } from "react";

import type { OperationSnapshot } from "../domain/operation";
import {
  mapProbeStateToView,
  type CapabilitySource,
  type OmpCapability,
  type OmpInstallation,
  type ProbeDiagnostic,
  type ProbeFailureCode,
  type ProbeReport,
  type ProbeViewState,
} from "../domain/probe";
import { useOmpProbe } from "../hooks/useOmpProbe";
import { getCapabilityLabel, type Translate } from "../i18n";
import type { Locale, TranslationKey } from "../i18n/resources";

interface ProbeWorkbenchProps {
  readonly locale: Locale;
  readonly t: Translate;
}

interface StatusCopy {
  readonly title: TranslationKey;
  readonly body: TranslationKey;
}

const statusCopy: Readonly<Record<Exclude<ProbeViewState, "error">, StatusCopy>> = {
  loading: {
    title: "probe.loading.title",
    body: "probe.loading.body",
  },
  missing: {
    title: "probe.missing.title",
    body: "probe.missing.body",
  },
  ready: {
    title: "probe.ready.title",
    body: "probe.ready.body",
  },
  limited: {
    title: "probe.limited.title",
    body: "probe.limited.body",
  },
};

const sourceKeys: Readonly<Record<CapabilitySource, TranslationKey>> = {
  cli: "source.cli",
  broker: "source.broker",
  gateway: "source.gateway",
  interactive: "source.interactive",
  unavailable: "source.unavailable",
};

const failureBodyKeys: Readonly<Record<ProbeFailureCode, TranslationKey>> = {
  invoke_failed: "probe.error.invokeFailed",
  invalid_payload: "probe.error.invalidPayload",
  operation_failed: "probe.error.operationFailed",
  operation_timed_out: "probe.error.operationTimedOut",
  operation_interrupted: "probe.error.operationInterrupted",
};

function formatTime(epochMs: number | null, locale: Locale, t: Translate): string {
  if (epochMs === null) {
    return t("time.unknown");
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(epochMs);
}

function Surface({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={`surface ${className}`.trim()}>{children}</section>;
}

function StatusSummary({
  viewState,
  failureCode,
  targetId,
  operation,
  isLoading,
  onRetry,
  t,
}: {
  readonly viewState: ProbeViewState;
  readonly failureCode: ProbeFailureCode | null;
  readonly targetId: string | null;
  readonly operation: OperationSnapshot | null;
  readonly isLoading: boolean;
  readonly onRetry: () => void;
  readonly t: Translate;
}) {
  const copy =
    viewState === "error"
      ? {
          title: "probe.error.title" as const,
          body:
            failureCode === null
              ? ("probe.error.invokeFailed" as const)
              : failureBodyKeys[failureCode],
        }
      : statusCopy[viewState];

  return (
    <Surface className={`status-summary status-${viewState}`}>
      <div className="status-copy" aria-live="polite" aria-atomic="true">
        <span className="status-mark" aria-hidden="true" />
        <div>
          <h2>{t(copy.title)}</h2>
          <p>{t(copy.body)}</p>
          {targetId === null ? null : (
            <p className="target-line">
              <span>{t("probe.target")}</span>
              <code>{targetId}</code>
            </p>
          )}
          {operation === null ? null : (
            <p className="target-line operation-line">
              <span>{t("operation.id")}</span>
              <code>{operation.operation_id}</code>
              <span>{t("operation.status")}</span>
              <code>{operation.status}</code>
              <span>{t("operation.revision")}</span>
              <code>{operation.revision}</code>
            </p>
          )}
        </div>
      </div>
      <button className="primary-button" type="button" onClick={onRetry} disabled={isLoading}>
        <span className={isLoading ? "button-spinner" : "retry-arrow"} aria-hidden="true" />
        {t(isLoading ? "action.checking" : "action.retry")}
      </button>
    </Surface>
  );
}

function InstallationDetails({
  installation,
  locale,
  t,
}: {
  readonly installation: OmpInstallation | null;
  readonly locale: Locale;
  readonly t: Translate;
}) {
  return (
    <Surface>
      <div className="section-heading">
        <h2>{t("installation.heading")}</h2>
      </div>
      {installation === null ? (
        <p className="empty-state">{t("installation.notAvailable")}</p>
      ) : (
        <dl className="definition-grid">
          <div className="definition-wide">
            <dt>{t("installation.executablePath")}</dt>
            <dd>
              <code>{installation.executable_path}</code>
            </dd>
          </div>
          <div>
            <dt>{t("installation.version")}</dt>
            <dd>{installation.version}</dd>
          </div>
          <div>
            <dt>{t("installation.architecture")}</dt>
            <dd>{installation.architecture}</dd>
          </div>
          <div>
            <dt>{t("installation.probedAt")}</dt>
            <dd>{formatTime(installation.probed_at_epoch_ms, locale, t)}</dd>
          </div>
          <div>
            <dt>{t("installation.binaryModifiedAt")}</dt>
            <dd>{formatTime(installation.binary_modified_at_epoch_ms, locale, t)}</dd>
          </div>
        </dl>
      )}
    </Surface>
  );
}

function AvailabilityBadge({
  available,
  t,
}: {
  readonly available: boolean;
  readonly t: Translate;
}) {
  return (
    <span className={`availability-badge ${available ? "is-available" : "is-unavailable"}`}>
      <span aria-hidden="true" />
      {t(available ? "availability.available" : "availability.unavailable")}
    </span>
  );
}

function CapabilityTable({
  capabilities,
  t,
}: {
  readonly capabilities: readonly OmpCapability[];
  readonly t: Translate;
}) {
  return (
    <Surface>
      <div className="section-heading">
        <div>
          <h2>{t("capabilities.heading")}</h2>
          <p>{t("capabilities.description")}</p>
        </div>
        <span className="count-badge" aria-hidden="true">
          {capabilities.length}
        </span>
      </div>
      {capabilities.length === 0 ? (
        <p className="empty-state">{t("capabilities.empty")}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("capabilities.name")}</th>
                <th scope="col">{t("capabilities.availability")}</th>
                <th scope="col">{t("capabilities.source")}</th>
                <th scope="col">{t("capabilities.evidence")}</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.map((capability, index) => (
                <tr key={`${capability.id}-${index}`}>
                  <td>
                    <strong>{getCapabilityLabel(capability.id, t)}</strong>
                    <code className="capability-id">{capability.id}</code>
                  </td>
                  <td>
                    <AvailabilityBadge available={capability.available} t={t} />
                  </td>
                  <td>{t(sourceKeys[capability.source])}</td>
                  <td className="evidence-cell">
                    {capability.evidence.length === 0 ? t("time.unknown") : capability.evidence}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Surface>
  );
}

function DiagnosticItem({
  diagnostic,
  t,
}: {
  readonly diagnostic: ProbeDiagnostic;
  readonly t: Translate;
}) {
  return (
    <li className="diagnostic-item">
      <div className="diagnostic-title-row">
        <h3>{diagnostic.message}</h3>
        <code>{diagnostic.code}</code>
      </div>
      <dl className="diagnostic-grid">
        <div>
          <dt>{t("diagnostics.suggestion")}</dt>
          <dd>{diagnostic.suggestion || t("diagnostics.noSuggestion")}</dd>
        </div>
        <div>
          <dt>{t("diagnostics.retryable")}</dt>
          <dd>
            {t(diagnostic.retryable ? "diagnostics.retryableYes" : "diagnostics.retryableNo")}
          </dd>
        </div>
        <div className="diagnostic-detail">
          <dt>{t("diagnostics.technicalDetail")}</dt>
          <dd>
            <code>
              {diagnostic.technical_detail_redacted || t("diagnostics.noTechnicalDetail")}
            </code>
          </dd>
        </div>
      </dl>
    </li>
  );
}

function Diagnostics({
  diagnostics,
  t,
}: {
  readonly diagnostics: readonly ProbeDiagnostic[];
  readonly t: Translate;
}) {
  if (diagnostics.length === 0) {
    return null;
  }
  return (
    <Surface>
      <div className="section-heading">
        <h2>{t("diagnostics.heading")}</h2>
        <span className="count-badge warning-count" aria-hidden="true">
          {diagnostics.length}
        </span>
      </div>
      <ol className="diagnostic-list">
        {diagnostics.map((diagnostic, index) => (
          <DiagnosticItem key={`${diagnostic.code}-${index}`} diagnostic={diagnostic} t={t} />
        ))}
      </ol>
    </Surface>
  );
}

function ProbeResults({
  report,
  locale,
  t,
}: {
  readonly report: ProbeReport;
  readonly locale: Locale;
  readonly t: Translate;
}) {
  return (
    <div className="results-stack">
      <InstallationDetails installation={report.installation} locale={locale} t={t} />
      <CapabilityTable capabilities={report.capabilities} t={t} />
      <Diagnostics diagnostics={report.diagnostics} t={t} />
    </div>
  );
}

export function ProbeWorkbench({ locale, t }: ProbeWorkbenchProps) {
  const { state, operation, operationRefreshFailure, retry } = useOmpProbe();
  const viewState = mapProbeStateToView(state);
  const report = state.phase === "resolved" ? state.report : null;
  const failureCode = state.phase === "failed" ? state.code : null;
  const operationDiagnostics = [
    ...(state.phase === "failed" && state.diagnostic !== null ? [state.diagnostic] : []),
    ...(operation?.persistence_diagnostic === null ||
    operation?.persistence_diagnostic === undefined
      ? []
      : [operation.persistence_diagnostic]),
    ...(operationRefreshFailure === null
      ? []
      : [
          {
            code: "operation_status_refresh_failed",
            message: t(
              operationRefreshFailure === "invalid_payload"
                ? "operation.refreshInvalidPayload"
                : "operation.refreshFailed",
            ),
            suggestion: t("operation.refreshSuggestion"),
            retryable: true,
            technical_detail_redacted: "stage=operation_status_refresh",
          },
        ]),
  ];

  return (
    <section
      className="workbench probe-workbench"
      aria-labelledby="probe-workbench-heading"
      aria-busy={state.phase === "loading"}
    >
      <div className="workbench-intro">
        <div>
          <p className="eyebrow">{t("app.kicker")}</p>
          <h1 id="probe-workbench-heading">{t("probe.heading")}</h1>
          <p>{t("probe.description")}</p>
        </div>
      </div>

      <StatusSummary
        viewState={viewState}
        failureCode={failureCode}
        targetId={report?.target_id ?? operation?.target_id ?? null}
        operation={operation}
        isLoading={state.phase === "loading"}
        onRetry={retry}
        t={t}
      />

      {report === null ? null : <ProbeResults report={report} locale={locale} t={t} />}
      {operationDiagnostics.length === 0 ? null : (
        <div className="results-stack">
          <Diagnostics diagnostics={operationDiagnostics} t={t} />
        </div>
      )}

      <p className="privacy-note">
        <span aria-hidden="true">◆</span>
        {t("privacy.note")}
      </p>
    </section>
  );
}
