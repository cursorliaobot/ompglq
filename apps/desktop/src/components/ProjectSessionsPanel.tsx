import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from "react";

import type {
  ProfileSessionRootStatus,
  ProjectSessionPreview,
  ProjectSessionSummary,
  SessionFailure,
  SessionFreshness,
  SessionReadStatus,
} from "../domain/session";
import type { ProjectSessionState } from "../hooks/project-session-state";
import { useProjectSessions } from "../hooks/useProjectSessions";
import type { Translate } from "../i18n";
import type { Locale, TranslationKey } from "../i18n/resources";

const PAGE_SIZE = 50;
const MAX_SEARCH_CHARACTERS = 128;

const rootStatusKeys: Readonly<Record<ProfileSessionRootStatus, TranslationKey>> = {
  unconfigured: "project.sessions.root.unconfigured",
  active: "project.sessions.root.active",
  offline: "project.sessions.root.offline",
  replaced: "project.sessions.root.replaced",
  revoked: "project.sessions.root.revoked",
};

const rootDescriptionKeys: Readonly<Record<ProfileSessionRootStatus, TranslationKey>> = {
  unconfigured: "project.sessions.root.unconfiguredBody",
  active: "project.sessions.root.activeBody",
  offline: "project.sessions.root.offlineBody",
  replaced: "project.sessions.root.replacedBody",
  revoked: "project.sessions.root.revokedBody",
};

const readStatusKeys: Readonly<Record<SessionReadStatus, TranslationKey>> = {
  readable: "project.sessions.read.readable",
  partial: "project.sessions.read.partial",
  unreadable: "project.sessions.read.unreadable",
};

const freshnessKeys: Readonly<Record<SessionFreshness, TranslationKey>> = {
  fresh: "project.sessions.freshness.fresh",
  stale: "project.sessions.freshness.stale",
  missing: "project.sessions.freshness.missing",
  failed: "project.sessions.freshness.failed",
};

function diagnosticKeys(code: string): readonly [TranslationKey, TranslationKey] {
  switch (code) {
    case "profile_session_root_offline":
      return [
        "project.sessions.diagnostic.offline",
        "project.sessions.diagnostic.offlineSuggestion",
      ];
    case "profile_session_root_replaced":
      return [
        "project.sessions.diagnostic.replaced",
        "project.sessions.diagnostic.replacedSuggestion",
      ];
    case "profile_session_root_revoked":
      return [
        "project.sessions.diagnostic.revoked",
        "project.sessions.diagnostic.revokedSuggestion",
      ];
    case "profile_session_root_not_configured":
      return ["project.sessions.root.unconfigured", "project.sessions.root.unconfiguredBody"];
    case "session_scan_in_progress":
      return ["project.sessions.diagnostic.busy", "project.sessions.diagnostic.busySuggestion"];
    case "session_platform_identity_unverified":
      return [
        "project.sessions.diagnostic.platform",
        "project.sessions.diagnostic.platformSuggestion",
      ];
    case "session_listing_entries_skipped":
      return [
        "project.sessions.diagnostic.skipped",
        "project.sessions.diagnostic.skippedSuggestion",
      ];
    case "session_cwd_not_absolute":
    case "session_cwd_unavailable":
      return ["project.sessions.diagnostic.cwd", "project.sessions.diagnostic.cwdSuggestion"];
    case "session_profile_binding_changed":
    case "session_scan_scope_changed":
      return ["project.sessions.diagnostic.scope", "project.sessions.diagnostic.scopeSuggestion"];
    case "session_preview_file_replaced":
    case "session_preview_id_changed":
    case "session_preview_project_changed":
    case "session_preview_scope_changed":
      return [
        "project.sessions.diagnostic.previewChanged",
        "project.sessions.diagnostic.previewChangedSuggestion",
      ];
    case "session_preview_not_found":
    case "session_preview_identity_unavailable":
    case "session_preview_path_outside_root":
    case "session_preview_cwd_unavailable":
    case "allowed_file_unavailable":
    case "allowed_file_changed":
    case "allowed_file_invalid":
    case "allowed_file_read_failed":
      return [
        "project.sessions.diagnostic.previewUnavailable",
        "project.sessions.diagnostic.previewUnavailableSuggestion",
      ];
    case "session_root_overlaps_profile":
    case "session_root_already_bound":
      return [
        "project.sessions.diagnostic.rootConflict",
        "project.sessions.diagnostic.rootConflictSuggestion",
      ];
    case "session_entry_limit_exceeded":
    case "session_directory_limit_exceeded":
    case "session_file_limit_exceeded":
    case "session_scan_byte_limit_exceeded":
    case "session_file_too_large":
    case "session_record_limit_exceeded":
    case "session_preview_content_too_large":
    case "session_preview_metadata_too_large":
      return ["project.sessions.diagnostic.limit", "project.sessions.diagnostic.limitSuggestion"];
    case "session_header_missing":
    case "session_header_invalid":
    case "session_branch_inconsistent":
    case "session_parse_limits_invalid":
    case "session_preview_metadata_invalid":
      return ["project.sessions.diagnostic.parse", "project.sessions.diagnostic.parseSuggestion"];
    default:
      return [
        "project.sessions.diagnostic.generic",
        "project.sessions.diagnostic.genericSuggestion",
      ];
  }
}

interface ProjectSessionsPanelProps {
  readonly projectId: number;
  readonly profile: string;
  readonly bindingRevision: number;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly t: Translate;
}

interface ProjectSessionsContentProps {
  readonly state: ProjectSessionState;
  readonly visibleSessions: readonly ProjectSessionSummary[];
  readonly matchingCount: number;
  readonly searchQuery: string;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly t: Translate;
  readonly onSearchChange: (value: string) => void;
  readonly onRefresh: () => void;
  readonly onAuthorize: () => void;
  readonly onScan: () => void;
  readonly onOpenPreview: (session: ProjectSessionSummary) => void;
  readonly onClosePreview: () => void;
  readonly onDismissMutationFailure: () => void;
  readonly onShowMore: () => void;
}

function formatTime(epochMs: number, locale: Locale, t: Translate): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(epochMs);
  } catch {
    return t("time.unknown");
  }
}

function formatBytes(bytes: number, locale: Locale): string {
  if (bytes < 1_024) {
    return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1_024;
  let unit: (typeof units)[number] = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1_024) {
      break;
    }
    value /= 1_024;
    unit = candidate;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function failureBody(failure: SessionFailure, t: Translate): string {
  if (failure.kind === "invalid_payload") {
    return t("project.sessions.error.invalidPayload");
  }
  if (failure.kind === "invoke_failed") {
    return t("project.sessions.error.invokeFailed");
  }
  return t(diagnosticKeys(failure.diagnostic.code)[0]);
}

function SessionFailureNotice({
  failure,
  title,
  actionLabel,
  onAction,
  t,
}: {
  readonly failure: SessionFailure;
  readonly title: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly t: Translate;
}) {
  const diagnostic = failure.kind === "backend" ? failure.diagnostic : null;
  const localizedSuggestion = diagnostic === null ? null : t(diagnosticKeys(diagnostic.code)[1]);
  return (
    <section className="session-notice session-notice-error" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{failureBody(failure, t)}</p>
        {diagnostic === null ? null : (
          <div className="session-notice-detail">
            <p>{localizedSuggestion}</p>
            <code>{diagnostic.code}</code>
            {diagnostic.technical_detail_redacted.length === 0 ? null : (
              <details>
                <summary>{t("diagnostics.technicalDetail")}</summary>
                <code>{diagnostic.technical_detail_redacted}</code>
              </details>
            )}
          </div>
        )}
      </div>
      <button className="text-button" type="button" onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  );
}

function SessionRow({
  session,
  previewDisabled,
  previewLoading,
  previewOpen,
  locale,
  t,
  onPreview,
}: {
  readonly session: ProjectSessionSummary;
  readonly previewDisabled: boolean;
  readonly previewLoading: boolean;
  readonly previewOpen: boolean;
  readonly locale: Locale;
  readonly t: Translate;
  readonly onPreview: (session: ProjectSessionSummary) => void;
}) {
  return (
    <li>
      <article className={`session-row freshness-${session.freshness}`}>
        <div className="session-row-heading">
          <div>
            <h4>{session.title.length === 0 ? t("project.sessions.untitled") : session.title}</h4>
            <code>{session.session_id}</code>
          </div>
          <div className="session-row-controls">
            <div className="session-badges">
              <span className={`session-badge read-${session.read_status}`}>
                {t(readStatusKeys[session.read_status])}
              </span>
              <span className={`session-badge freshness-${session.freshness}`}>
                {t(freshnessKeys[session.freshness])}
              </span>
            </div>
            <button
              className="text-button"
              type="button"
              disabled={previewDisabled}
              aria-expanded={previewOpen}
              aria-controls={`session-preview-${session.session_index_id}`}
              onClick={() => onPreview(session)}
            >
              {previewLoading ? <span className="button-spinner" aria-hidden="true" /> : null}
              {t(
                previewLoading
                  ? "project.sessions.preview.loadingAction"
                  : "project.sessions.preview.action",
              )}
            </button>
          </div>
        </div>
        <dl className="session-metadata">
          <div>
            <dt>{t("project.sessions.modified")}</dt>
            <dd>{formatTime(session.modified_at_epoch_ms, locale, t)}</dd>
          </div>
          <div>
            <dt>{t("project.sessions.model")}</dt>
            <dd>{session.model_selector ?? t("project.sessions.notRecorded")}</dd>
          </div>
          <div>
            <dt>{t("project.sessions.messages")}</dt>
            <dd>{new Intl.NumberFormat(locale).format(session.message_count)}</dd>
          </div>
          <div>
            <dt>{t("project.sessions.size")}</dt>
            <dd>{formatBytes(session.size_bytes, locale)}</dd>
          </div>
          <div className="session-cwd">
            <dt>{t("project.sessions.cwd")}</dt>
            <dd>
              <code>{session.cwd_display}</code>
            </dd>
          </div>
          {session.credential_providers.length === 0 ? null : (
            <div className="session-providers">
              <dt>{t("project.sessions.credentialProviders")}</dt>
              <dd>{session.credential_providers.join(", ")}</dd>
            </div>
          )}
        </dl>
        {session.warning_codes.length === 0 ? null : (
          <details className="session-warnings">
            <summary>
              {t("project.sessions.warnings")} · {session.warning_codes.length}
            </summary>
            <ul>
              {session.warning_codes.map((warning) => (
                <li key={warning}>
                  <code>{warning}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </article>
    </li>
  );
}

function formatMessageTimestamp(timestamp: string | null, locale: Locale, t: Translate): string {
  if (timestamp === null) {
    return t("time.unknown");
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? formatTime(parsed, locale, t) : timestamp;
}

function SessionPreview({
  preview,
  locale,
  t,
  onClose,
}: {
  readonly preview: ProjectSessionPreview;
  readonly locale: Locale;
  readonly t: Translate;
  readonly onClose: () => void;
}) {
  const modelRoles = Object.entries(preview.model_roles);
  return (
    <section
      id={`session-preview-${preview.session_index_id}`}
      className="session-preview"
      aria-labelledby={`session-preview-heading-${preview.session_index_id}`}
    >
      <div className="session-preview-header">
        <div>
          <p className="eyebrow">{t("project.sessions.preview.kicker")}</p>
          <h4 id={`session-preview-heading-${preview.session_index_id}`}>
            {preview.title.length === 0 ? t("project.sessions.untitled") : preview.title}
          </h4>
          <code>{preview.session_id}</code>
        </div>
        <button className="text-button" type="button" onClick={onClose}>
          {t("project.sessions.preview.close")}
        </button>
      </div>

      <p className="session-preview-privacy">{t("project.sessions.preview.memoryOnly")}</p>

      {preview.first_message_summary === null ? null : (
        <div className="session-preview-summary">
          <strong>{t("project.sessions.preview.firstMessage")}</strong>
          <p>{preview.first_message_summary}</p>
        </div>
      )}

      <dl className="session-preview-metadata">
        <div>
          <dt>{t("project.sessions.model")}</dt>
          <dd>{preview.model_selector ?? t("project.sessions.notRecorded")}</dd>
        </div>
        <div>
          <dt>{t("project.sessions.preview.thinking")}</dt>
          <dd>{preview.thinking_level ?? t("project.sessions.notRecorded")}</dd>
        </div>
        <div>
          <dt>{t("project.sessions.messages")}</dt>
          <dd>{new Intl.NumberFormat(locale).format(preview.message_count)}</dd>
        </div>
        <div>
          <dt>{t("project.sessions.preview.skippedRecords")}</dt>
          <dd>{new Intl.NumberFormat(locale).format(preview.skipped_record_count)}</dd>
        </div>
        <div>
          <dt>{t("project.sessions.size")}</dt>
          <dd>{formatBytes(preview.source_size_bytes, locale)}</dd>
        </div>
        <div>
          <dt>{t("project.sessions.modified")}</dt>
          <dd>{formatTime(preview.source_modified_at_epoch_ms, locale, t)}</dd>
        </div>
        <div className="session-preview-wide">
          <dt>{t("project.sessions.cwd")}</dt>
          <dd>
            <code>{preview.cwd_display}</code>
          </dd>
        </div>
        {preview.credential_providers.length === 0 ? null : (
          <div className="session-preview-wide">
            <dt>{t("project.sessions.credentialProviders")}</dt>
            <dd>{preview.credential_providers.join(", ")}</dd>
          </div>
        )}
      </dl>

      {modelRoles.length === 0 ? null : (
        <details className="session-preview-roles">
          <summary>
            {t("project.sessions.preview.modelRoles")} · {modelRoles.length}
          </summary>
          <dl>
            {modelRoles.map(([role, model]) => (
              <div key={role}>
                <dt>{role}</dt>
                <dd>{model}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {preview.warning_codes.length === 0 ? null : (
        <details className="session-warnings" open>
          <summary>
            {t("project.sessions.warnings")} · {preview.warning_codes.length}
          </summary>
          <ul>
            {preview.warning_codes.map((warning) => (
              <li key={warning}>
                <code>{warning}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="session-preview-transcript">
        <div className="session-preview-transcript-heading">
          <h5>{t("project.sessions.preview.transcript")}</h5>
          <span>{new Intl.NumberFormat(locale).format(preview.messages.length)}</span>
        </div>
        {preview.messages.length === 0 ? (
          <p className="session-preview-empty">{t("project.sessions.preview.empty")}</p>
        ) : (
          <ol>
            {preview.messages.map((message, index) => (
              <li key={`${index}-${message.timestamp ?? "unknown"}`}>
                <div>
                  <strong>{message.role}</strong>
                  <time>{formatMessageTimestamp(message.timestamp, locale, t)}</time>
                </div>
                <p>{message.text}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function ProjectSessionsContent({
  state,
  visibleSessions,
  matchingCount,
  searchQuery,
  disabled,
  locale,
  t,
  onSearchChange,
  onRefresh,
  onAuthorize,
  onScan,
  onOpenPreview,
  onClosePreview,
  onDismissMutationFailure,
  onShowMore,
}: ProjectSessionsContentProps) {
  const snapshot = state.snapshot;
  const mutationBusy =
    state.mutation.phase === "authorizing" || state.mutation.phase === "scanning";
  const previewBusy = state.preview.phase === "loading";
  const controlsDisabled = disabled || mutationBusy || previewBusy;
  const mutationFailure = state.mutation.phase === "failed" ? state.mutation : null;

  if (snapshot === null) {
    if (state.loadPhase === "failed" && state.loadFailure !== null) {
      return (
        <div className="project-sessions-content">
          <SessionFailureNotice
            failure={state.loadFailure}
            title={t("project.sessions.error.loadTitle")}
            actionLabel={t("project.sessions.retry")}
            onAction={onRefresh}
            t={t}
          />
        </div>
      );
    }
    return (
      <div className="project-sessions-content" aria-live="polite">
        <span className="button-spinner" aria-hidden="true" />
        <p>{t("project.sessions.loading")}</p>
      </div>
    );
  }

  const canScan = snapshot.root_status !== "unconfigured" && snapshot.root_status !== "revoked";
  return (
    <div
      className="project-sessions-content"
      aria-busy={state.loadPhase === "loading" || mutationBusy || previewBusy}
    >
      <div className="session-root-header">
        <div>
          <span className={`session-root-badge root-${snapshot.root_status}`}>
            {t(rootStatusKeys[snapshot.root_status])}
          </span>
          <h3>{snapshot.profile}</h3>
          <p>{t(rootDescriptionKeys[snapshot.root_status])}</p>
        </div>
        <div className="session-root-time">
          <span>{t("project.sessions.lastScanned")}</span>
          <strong>
            {snapshot.last_scanned_at_epoch_ms === null
              ? t("project.sessions.neverScanned")
              : formatTime(snapshot.last_scanned_at_epoch_ms, locale, t)}
          </strong>
        </div>
      </div>

      <p className="session-inventory-note">{t("project.sessions.inventoryIncomplete")}</p>

      <div className="session-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={controlsDisabled}
          onClick={onAuthorize}
        >
          {state.mutation.phase === "authorizing" ? (
            <span className="button-spinner" aria-hidden="true" />
          ) : null}
          {t(
            state.mutation.phase === "authorizing"
              ? "project.sessions.authorizing"
              : snapshot.root_status === "unconfigured"
                ? "project.sessions.authorize"
                : "project.sessions.reauthorize",
          )}
        </button>
        {canScan ? (
          <button
            className="secondary-button"
            type="button"
            disabled={controlsDisabled}
            onClick={onScan}
          >
            {state.mutation.phase === "scanning" ? (
              <span className="button-spinner" aria-hidden="true" />
            ) : null}
            {t(
              state.mutation.phase === "scanning"
                ? "project.sessions.scanning"
                : "project.sessions.scan",
            )}
          </button>
        ) : null}
      </div>

      {state.loadFailure === null ? null : (
        <SessionFailureNotice
          failure={state.loadFailure}
          title={t("project.sessions.error.refreshTitle")}
          actionLabel={t("project.sessions.retry")}
          onAction={onRefresh}
          t={t}
        />
      )}

      {mutationFailure === null ? null : (
        <SessionFailureNotice
          failure={mutationFailure.failure}
          title={t(
            mutationFailure.action === "authorize"
              ? "project.sessions.error.authorizeTitle"
              : "project.sessions.error.scanTitle",
          )}
          actionLabel={t("project.sessions.dismiss")}
          onAction={onDismissMutationFailure}
          t={t}
        />
      )}

      {snapshot.diagnostics.length === 0 ? null : (
        <details className="session-scan-diagnostics">
          <summary>
            {t("project.sessions.diagnostics")} · {snapshot.diagnostics.length}
          </summary>
          <ul>
            {snapshot.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`}>
                <strong>{t(diagnosticKeys(diagnostic.code)[0])}</strong>
                <code>{diagnostic.code}</code>
                <p>{t(diagnosticKeys(diagnostic.code)[1])}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {state.preview.phase === "loading" ? (
        <section
          id={`session-preview-${state.preview.sessionIndexId}`}
          className="session-preview session-preview-loading"
          role="status"
          aria-live="polite"
        >
          <span className="button-spinner" aria-hidden="true" />
          <div>
            <strong>{t("project.sessions.preview.loadingTitle")}</strong>
            <p>{t("project.sessions.preview.loadingBody")}</p>
          </div>
        </section>
      ) : state.preview.phase === "failed" ? (
        <div id={`session-preview-${state.preview.sessionIndexId}`} className="session-preview">
          <SessionFailureNotice
            failure={state.preview.failure}
            title={t("project.sessions.preview.errorTitle")}
            actionLabel={t("project.sessions.preview.close")}
            onAction={onClosePreview}
            t={t}
          />
        </div>
      ) : state.preview.phase === "ready" ? (
        <SessionPreview
          preview={state.preview.preview}
          locale={locale}
          t={t}
          onClose={onClosePreview}
        />
      ) : null}

      {snapshot.sessions.length === 0 ? (
        <div className="session-empty">
          <strong>{t("project.sessions.emptyTitle")}</strong>
          <p>{t("project.sessions.emptyBody")}</p>
        </div>
      ) : (
        <>
          <div className="session-list-toolbar">
            <label>
              <span>{t("project.sessions.search")}</span>
              <input
                type="search"
                value={searchQuery}
                maxLength={MAX_SEARCH_CHARACTERS}
                placeholder={t("project.sessions.searchPlaceholder")}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onSearchChange(event.currentTarget.value)
                }
              />
            </label>
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={`${t("project.sessions.resultCount")}: ${new Intl.NumberFormat(
                locale,
              ).format(matchingCount)} / ${new Intl.NumberFormat(locale).format(
                snapshot.sessions.length,
              )}`}
            >
              {new Intl.NumberFormat(locale).format(matchingCount)} /{" "}
              {new Intl.NumberFormat(locale).format(snapshot.sessions.length)}
            </span>
          </div>
          {matchingCount === 0 ? (
            <div className="session-empty">
              <strong>{t("project.sessions.noMatchesTitle")}</strong>
              <p>{t("project.sessions.noMatchesBody")}</p>
            </div>
          ) : (
            <>
              <ul className="session-list">
                {visibleSessions.map((session) => {
                  const previewLoading =
                    state.preview.phase === "loading" &&
                    state.preview.sessionIndexId === session.session_index_id;
                  const previewOpen =
                    previewLoading ||
                    (state.preview.phase === "failed" &&
                      state.preview.sessionIndexId === session.session_index_id) ||
                    (state.preview.phase === "ready" &&
                      state.preview.preview.session_index_id === session.session_index_id);
                  return (
                    <SessionRow
                      key={session.session_index_id}
                      session={session}
                      previewDisabled={controlsDisabled}
                      previewLoading={previewLoading}
                      previewOpen={previewOpen}
                      locale={locale}
                      t={t}
                      onPreview={onOpenPreview}
                    />
                  );
                })}
              </ul>
              {visibleSessions.length < matchingCount ? (
                <button
                  className="text-button session-show-more"
                  type="button"
                  onClick={onShowMore}
                >
                  {t("project.sessions.showMore")}
                </button>
              ) : null}
            </>
          )}
        </>
      )}
      <p className="session-privacy-note">{t("project.sessions.metadataOnly")}</p>
    </div>
  );
}

export function ProjectSessionsPanel({
  projectId,
  profile,
  bindingRevision,
  disabled,
  locale,
  t,
}: ProjectSessionsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const controller = useProjectSessions(projectId, profile, bindingRevision, expanded && !disabled);
  const snapshot = controller.state.snapshot;
  const matchingSessions = useMemo(() => {
    const sessions = snapshot?.sessions ?? [];
    const query = deferredQuery.trim().toLocaleLowerCase(locale);
    if (query.length === 0) {
      return sessions;
    }
    return sessions.filter((session) =>
      [
        session.title,
        session.session_id,
        session.cwd_display,
        session.model_selector ?? "",
        session.provider ?? "",
        ...session.credential_providers,
      ]
        .join("\n")
        .toLocaleLowerCase(locale)
        .includes(query),
    );
  }, [deferredQuery, locale, snapshot]);

  useEffect(() => {
    setSearchQuery("");
    setVisibleCount(PAGE_SIZE);
  }, [bindingRevision, profile, projectId]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [deferredQuery, controller.state.snapshot]);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const open = event.currentTarget.open;
    setExpanded(open);
    if (!open) {
      controller.closePreview();
    }
  };

  return (
    <details className="project-sessions-panel" onToggle={handleToggle}>
      <summary>
        <span>{t("project.sessions.summary")}</span>
        {controller.state.snapshot === null ? null : (
          <span className="count-badge" aria-hidden="true">
            {controller.state.snapshot.sessions.length}
          </span>
        )}
      </summary>
      {expanded ? (
        <ProjectSessionsContent
          state={controller.state}
          visibleSessions={matchingSessions.slice(0, visibleCount)}
          matchingCount={matchingSessions.length}
          searchQuery={searchQuery}
          disabled={disabled}
          locale={locale}
          t={t}
          onSearchChange={setSearchQuery}
          onRefresh={controller.refresh}
          onAuthorize={controller.authorize}
          onScan={controller.scan}
          onOpenPreview={controller.openPreview}
          onClosePreview={controller.closePreview}
          onDismissMutationFailure={controller.clearMutationFailure}
          onShowMore={() => setVisibleCount((value) => value + PAGE_SIZE)}
        />
      ) : null}
    </details>
  );
}
