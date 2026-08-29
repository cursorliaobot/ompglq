import type { DatabaseStatusFailureCode, DatabaseStatusMachineState } from "../domain/database";
import { useDatabaseStatus } from "../hooks/useDatabaseStatus";
import type { Translate } from "../i18n";
import type { TranslationKey } from "../i18n/resources";

interface DatabaseStatusPanelProps {
  readonly t: Translate;
}

interface DatabaseStatusViewProps extends DatabaseStatusPanelProps {
  readonly state: DatabaseStatusMachineState;
  readonly retry: () => void;
}

function RetryButton({
  isLoading,
  onRetry,
  t,
}: {
  readonly isLoading: boolean;
  readonly onRetry: () => void;
  readonly t: Translate;
}) {
  return (
    <button className="primary-button" type="button" onClick={onRetry} disabled={isLoading}>
      <span className={isLoading ? "button-spinner" : "retry-arrow"} aria-hidden="true" />
      {t(isLoading ? "database.retrying" : "database.retry")}
    </button>
  );
}

function DatabasePaths({
  databasePath,
  backupPath,
  t,
}: {
  readonly databasePath: string | null;
  readonly backupPath: string | null;
  readonly t: Translate;
}) {
  if (databasePath === null && backupPath === null) {
    return null;
  }

  return (
    <dl className="database-paths">
      {databasePath === null ? null : (
        <div>
          <dt>{t("database.path")}</dt>
          <dd>
            <code>{databasePath}</code>
          </dd>
        </div>
      )}
      {backupPath === null ? null : (
        <div>
          <dt>{t("database.backupPath")}</dt>
          <dd>
            <code>{backupPath}</code>
          </dd>
        </div>
      )}
    </dl>
  );
}

function failureCopy(code: DatabaseStatusFailureCode): TranslationKey {
  return code === "invalid_payload"
    ? "database.error.invalidPayload"
    : "database.error.invokeFailed";
}

export function DatabaseStatusView({ state, retry, t }: DatabaseStatusViewProps) {
  if (
    state.phase === "loading" ||
    (state.phase === "resolved" && state.report.availability === "initializing")
  ) {
    return (
      <section
        className="surface database-status database-status-loading"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="database-status-copy">
          <span className="status-mark" aria-hidden="true" />
          <div>
            <h2>{t("database.loading.title")}</h2>
            <p>{t("database.loading.body")}</p>
          </div>
        </div>
        <RetryButton isLoading onRetry={retry} t={t} />
      </section>
    );
  }

  if (state.phase === "failed") {
    return (
      <section className="surface database-status database-status-error" role="alert">
        <div className="database-status-copy">
          <span className="status-mark" aria-hidden="true" />
          <div>
            <h2>{t("database.error.title")}</h2>
            <p>{t(failureCopy(state.code))}</p>
          </div>
        </div>
        <RetryButton isLoading={false} onRetry={retry} t={t} />
      </section>
    );
  }

  const { report } = state;
  if (report.availability === "ready") {
    return (
      <section className="surface database-status database-status-ready" aria-live="polite">
        <div className="database-status-copy">
          <span className="status-mark" aria-hidden="true" />
          <div>
            <h2>{t("database.ready.title")}</h2>
            <p>{t("database.ready.body")}</p>
            <p className="database-version">
              <span>{t("database.schemaVersion")}</span>
              <code>{report.schema_version}</code>
              {report.applied_migrations.length === 0 ? null : (
                <>
                  <span>{t("database.appliedMigrations")}</span>
                  <code>{report.applied_migrations.join(", ")}</code>
                </>
              )}
            </p>
            <DatabasePaths
              databasePath={report.database_path}
              backupPath={report.migration_backup_path}
              t={t}
            />
          </div>
        </div>
      </section>
    );
  }

  const diagnostic = report.diagnostic;
  return (
    <section className="surface database-status database-status-error" role="alert">
      <div className="database-status-copy">
        <span className="status-mark" aria-hidden="true" />
        <div>
          <h2>{t("database.recovery.title")}</h2>
          <p>{t("database.recovery.body")}</p>
          {diagnostic === null ? null : (
            <div className="database-diagnostic">
              <strong>{diagnostic.message}</strong>
              <p>{diagnostic.suggestion}</p>
              <code>{diagnostic.code}</code>
              {diagnostic.technical_detail_redacted.length === 0 ? null : (
                <details>
                  <summary>{t("diagnostics.technicalDetail")}</summary>
                  <code>{diagnostic.technical_detail_redacted}</code>
                </details>
              )}
            </div>
          )}
          <DatabasePaths
            databasePath={report.database_path}
            backupPath={report.migration_backup_path}
            t={t}
          />
        </div>
      </div>
      {report.can_retry ? <RetryButton isLoading={false} onRetry={retry} t={t} /> : null}
    </section>
  );
}

export function DatabaseStatusPanel({ t }: DatabaseStatusPanelProps) {
  const { state, retry } = useDatabaseStatus();
  return <DatabaseStatusView state={state} retry={retry} t={t} />;
}
