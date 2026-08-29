import { useEffect, useId, useState, type FormEvent } from "react";

import type {
  AccountPolicy,
  AuthorizationStatus,
  KnownProfile,
  ProjectBindingDraft,
  ProjectFailure,
  ProjectSummary,
  SettingSource,
  TerminalMode,
  UpdateProjectBindingRequest,
} from "../domain/project";
import type { ProbeDiagnostic } from "../domain/probe";
import { useProjects } from "../hooks/useProjects";
import type { ProjectsState } from "../hooks/project-state";
import type { Translate } from "../i18n";
import type { Locale, TranslationKey } from "../i18n/resources";
import { ProjectSessionsPanel } from "./ProjectSessionsPanel";

interface ProjectWorkbenchProps {
  readonly enabled: boolean;
  readonly locale: Locale;
  readonly t: Translate;
}

interface ProjectWorkbenchViewProps {
  readonly state: ProjectsState;
  readonly locale: Locale;
  readonly t: Translate;
  readonly refresh: () => void;
  readonly addProject: (request: ProjectBindingDraft) => void;
  readonly updateProjectBinding: (request: UpdateProjectBindingRequest) => void;
  readonly openProjectInCursor: (projectId: number) => void;
  readonly clearFeedback: () => void;
}

const accountPolicyKeys: Readonly<Record<AccountPolicy, TranslationKey>> = {
  automatic: "project.accountPolicy.automatic",
  profile: "project.accountPolicy.profile",
  credential_pin: "project.accountPolicy.credentialPin",
};

const terminalModeKeys: Readonly<Record<TerminalMode, TranslationKey>> = {
  embedded: "project.terminalMode.embedded",
  external: "project.terminalMode.external",
};

const settingSourceKeys: Readonly<Record<SettingSource, TranslationKey>> = {
  launch_override: "project.source.launchOverride",
  session: "project.source.session",
  project: "project.source.project",
  profile: "project.source.profile",
  global: "project.source.global",
};

const authorizationKeys: Readonly<Record<AuthorizationStatus, TranslationKey>> = {
  active: "project.authorization.active",
  offline: "project.authorization.offline",
  replaced: "project.authorization.replaced",
  revoked: "project.authorization.revoked",
  missing: "project.authorization.missing",
};

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

function FailureNotice({
  failure,
  title,
  actionLabel,
  onAction,
  t,
}: {
  readonly failure: ProjectFailure;
  readonly title: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly t: Translate;
}) {
  const diagnostic = failure.kind === "backend" ? failure.diagnostic : null;
  const body =
    failure.kind === "invalid_payload"
      ? t("projects.error.invalidPayload")
      : failure.kind === "invoke_failed"
        ? t("projects.error.invokeFailed")
        : diagnostic?.message;

  return (
    <section className="surface project-notice project-notice-error" role="alert">
      <div className="project-notice-copy">
        <span className="status-mark" aria-hidden="true" />
        <div>
          <h2>{title}</h2>
          <p>{body}</p>
          {diagnostic === null ? null : (
            <div className="project-error-detail">
              {diagnostic.suggestion.length === 0 ? null : <p>{diagnostic.suggestion}</p>}
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
      </div>
      <button className="secondary-button" type="button" onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  );
}

function AddDiagnostics({
  diagnostics,
  onDismiss,
  t,
}: {
  readonly diagnostics: readonly ProbeDiagnostic[];
  readonly onDismiss: () => void;
  readonly t: Translate;
}) {
  if (diagnostics.length === 0) {
    return null;
  }

  return (
    <section className="surface project-warning" role="status" aria-live="polite">
      <div className="section-heading">
        <div>
          <h2>{t("project.add.warningTitle")}</h2>
          <p>{t("project.add.warningBody")}</p>
        </div>
        <button className="text-button" type="button" onClick={onDismiss}>
          {t("projects.dismiss")}
        </button>
      </div>
      <ol className="diagnostic-list">
        {diagnostics.map((diagnostic, index) => (
          <li className="diagnostic-item" key={`${diagnostic.code}-${index}`}>
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
              {diagnostic.technical_detail_redacted.length === 0 ? null : (
                <div className="diagnostic-detail">
                  <dt>{t("diagnostics.technicalDetail")}</dt>
                  <dd>
                    <code>{diagnostic.technical_detail_redacted}</code>
                  </dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AddProjectForm({
  disabled,
  isAdding,
  knownProfiles,
  onAdd,
  t,
}: {
  readonly disabled: boolean;
  readonly isAdding: boolean;
  readonly knownProfiles: readonly KnownProfile[];
  readonly onAdd: (request: ProjectBindingDraft) => void;
  readonly t: Translate;
}) {
  const profileListId = useId();
  const [profile, setProfile] = useState("default");
  const [accountPolicy, setAccountPolicy] = useState<"automatic" | "profile">("automatic");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedProfile = profile.trim();
    if (disabled || normalizedProfile.length === 0) {
      return;
    }
    onAdd({
      profile: normalizedProfile,
      terminal_mode: "embedded",
      account_policy: accountPolicy,
    });
  };

  return (
    <section className="surface project-add-surface">
      <div className="section-heading">
        <div>
          <h2>{t("project.add.heading")}</h2>
          <p>{t("project.add.description")}</p>
        </div>
      </div>
      <form className="project-form" onSubmit={handleSubmit}>
        <label>
          <span>{t("project.binding.profile")}</span>
          <input
            type="text"
            value={profile}
            list={profileListId}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled}
            onChange={(event) => setProfile(event.currentTarget.value)}
          />
          <datalist id={profileListId}>
            {knownProfiles.map((knownProfile) => (
              <option key={knownProfile.name} value={knownProfile.name} />
            ))}
          </datalist>
        </label>
        <label>
          <span>{t("project.binding.accountPolicy")}</span>
          <select
            value={accountPolicy}
            disabled={disabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "automatic" || value === "profile") {
                setAccountPolicy(value);
              }
            }}
          >
            <option value="automatic">{t("project.accountPolicy.automatic")}</option>
            <option value="profile">{t("project.accountPolicy.profile")}</option>
          </select>
        </label>
        <label>
          <span>{t("project.binding.terminalMode")}</span>
          <select value="embedded" disabled={disabled} onChange={() => undefined}>
            <option value="embedded">{t("project.terminalMode.embedded")}</option>
          </select>
        </label>
        <button className="primary-button project-add-button" type="submit" disabled={disabled}>
          <span className={isAdding ? "button-spinner" : "add-mark"} aria-hidden="true" />
          {t(isAdding ? "project.add.submitting" : "project.add.submit")}
        </button>
      </form>
      <p className="project-form-hint">{t("project.profile.inventoryIncomplete")}</p>
    </section>
  );
}

function ProjectBindingEditor({
  project,
  disabled,
  isSaving,
  knownProfiles,
  onUpdate,
  t,
}: {
  readonly project: ProjectSummary;
  readonly disabled: boolean;
  readonly isSaving: boolean;
  readonly knownProfiles: readonly KnownProfile[];
  readonly onUpdate: (request: UpdateProjectBindingRequest) => void;
  readonly t: Translate;
}) {
  const profileListId = `project-${project.id}-known-profiles`;
  const [profile, setProfile] = useState(project.binding.profile);
  const [accountPolicy, setAccountPolicy] = useState<"automatic" | "profile">(
    project.binding.account_policy === "profile" ? "profile" : "automatic",
  );

  useEffect(() => {
    setProfile(project.binding.profile);
    setAccountPolicy(project.binding.account_policy === "profile" ? "profile" : "automatic");
  }, [project.binding.account_policy, project.binding.profile, project.binding.revision]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedProfile = profile.trim();
    if (disabled || normalizedProfile.length === 0) {
      return;
    }
    onUpdate({
      project_id: project.id,
      expected_revision: project.binding.revision,
      profile: normalizedProfile,
      terminal_mode: "embedded",
      account_policy: accountPolicy,
    });
  };

  return (
    <details className="project-binding-editor">
      <summary>{t("project.binding.edit")}</summary>
      <form className="project-form project-binding-form" onSubmit={handleSubmit}>
        <label>
          <span>{t("project.binding.profile")}</span>
          <input
            type="text"
            value={profile}
            list={profileListId}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled}
            onChange={(event) => setProfile(event.currentTarget.value)}
          />
          <datalist id={profileListId}>
            {knownProfiles.map((knownProfile) => (
              <option key={knownProfile.name} value={knownProfile.name} />
            ))}
          </datalist>
        </label>
        <label>
          <span>{t("project.binding.accountPolicy")}</span>
          <select
            value={accountPolicy}
            disabled={disabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "automatic" || value === "profile") {
                setAccountPolicy(value);
              }
            }}
          >
            <option value="automatic">{t("project.accountPolicy.automatic")}</option>
            <option value="profile">{t("project.accountPolicy.profile")}</option>
          </select>
        </label>
        <label>
          <span>{t("project.binding.terminalMode")}</span>
          <select value="embedded" disabled={disabled} onChange={() => undefined}>
            <option value="embedded">{t("project.terminalMode.embedded")}</option>
          </select>
        </label>
        <button className="secondary-button project-save-button" type="submit" disabled={disabled}>
          {isSaving ? <span className="button-spinner" aria-hidden="true" /> : null}
          {t(isSaving ? "project.binding.saving" : "project.binding.save")}
        </button>
      </form>
      <p className="project-form-hint">{t("project.profile.inventoryIncomplete")}</p>
    </details>
  );
}

function ProjectCard({
  project,
  locale,
  mutation,
  disabled,
  knownProfiles,
  onUpdate,
  onOpen,
  t,
}: {
  readonly project: ProjectSummary;
  readonly locale: Locale;
  readonly mutation: ProjectsState["mutation"];
  readonly disabled: boolean;
  readonly knownProfiles: readonly KnownProfile[];
  readonly onUpdate: (request: UpdateProjectBindingRequest) => void;
  readonly onOpen: (projectId: number) => void;
  readonly t: Translate;
}) {
  const mutationBusy =
    disabled ||
    mutation.phase === "adding" ||
    mutation.phase === "updating" ||
    mutation.phase === "opening";
  const isSaving = mutation.phase === "updating" && mutation.projectId === project.id;
  const isOpening = mutation.phase === "opening" && mutation.projectId === project.id;
  const canAttemptEditor =
    project.authorization_status === "active" ||
    project.authorization_status === "offline" ||
    project.authorization_status === "replaced";
  const editorActionKey =
    project.authorization_status === "active"
      ? "project.editor.openCursor"
      : "project.editor.revalidateCursor";
  const bindingEditable =
    project.binding.terminal_mode === "embedded" &&
    (project.binding.account_policy === "automatic" ||
      project.binding.account_policy === "profile");

  return (
    <li>
      <article className={`surface project-card authorization-${project.authorization_status}`}>
        <div className="project-card-header">
          <div>
            <h2>{project.display_path}</h2>
            <code>{project.canonical_path}</code>
          </div>
          <span className={`authorization-badge is-${project.authorization_status}`}>
            <span aria-hidden="true" />
            {t(authorizationKeys[project.authorization_status])}
          </span>
        </div>

        <dl className="project-definition-grid">
          <div>
            <dt>{t("project.binding.profile")}</dt>
            <dd>
              <strong>{project.binding.profile}</strong>
              <span>{t(settingSourceKeys[project.binding.profile_source])}</span>
            </dd>
          </div>
          <div>
            <dt>{t("project.binding.accountPolicy")}</dt>
            <dd>
              <strong>{t(accountPolicyKeys[project.binding.account_policy])}</strong>
              <span>{t(settingSourceKeys[project.binding.account_policy_source])}</span>
            </dd>
          </div>
          <div>
            <dt>{t("project.binding.terminalMode")}</dt>
            <dd>
              <strong>{t(terminalModeKeys[project.binding.terminal_mode])}</strong>
              <span>{t(settingSourceKeys[project.binding.terminal_mode_source])}</span>
            </dd>
          </div>
          <div>
            <dt>{t("project.target")}</dt>
            <dd>
              <code>{project.target_id}</code>
            </dd>
          </div>
          <div>
            <dt>{t("project.lastUsed")}</dt>
            <dd>{formatTime(project.last_used_at_epoch_ms, locale, t)}</dd>
          </div>
          <div>
            <dt>{t("project.binding.revision")}</dt>
            <dd>
              <code>{project.binding.revision}</code>
              <span>{formatTime(project.binding.updated_at_epoch_ms, locale, t)}</span>
            </dd>
          </div>
        </dl>

        <div className="project-card-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={mutationBusy || !canAttemptEditor}
            onClick={() => onOpen(project.id)}
          >
            {isOpening ? <span className="button-spinner" aria-hidden="true" /> : null}
            {t(isOpening ? "project.editor.opening" : editorActionKey)}
          </button>
          <details className="project-more-actions">
            <summary>{t("project.actions.more")}</summary>
            <button
              className="text-button"
              type="button"
              disabled={mutationBusy || !canAttemptEditor}
              onClick={() => onOpen(project.id)}
            >
              {t(editorActionKey)}
            </button>
          </details>
        </div>
        {project.authorization_status === "active" ? null : (
          <p className="project-form-hint">{t("project.editor.authorizationRequired")}</p>
        )}

        <ProjectSessionsPanel
          key={`${project.id}:${project.binding.profile}:${project.binding.revision}`}
          projectId={project.id}
          profile={project.binding.profile}
          bindingRevision={project.binding.revision}
          disabled={mutationBusy}
          locale={locale}
          t={t}
        />

        {bindingEditable ? (
          <ProjectBindingEditor
            project={project}
            disabled={mutationBusy}
            isSaving={isSaving}
            knownProfiles={knownProfiles}
            onUpdate={onUpdate}
            t={t}
          />
        ) : (
          <p className="project-binding-unsupported">{t("project.binding.unsupported")}</p>
        )}
      </article>
    </li>
  );
}

export function ProjectWorkbenchView({
  state,
  locale,
  t,
  refresh,
  addProject,
  updateProjectBinding,
  openProjectInCursor,
  clearFeedback,
}: ProjectWorkbenchViewProps) {
  const loadBusy = state.loadPhase === "loading";
  const mutationBusy =
    state.mutation.phase === "adding" ||
    state.mutation.phase === "updating" ||
    state.mutation.phase === "opening";
  const canMutate = state.loadPhase === "ready" && !mutationBusy;
  const mutationFailure = state.mutation.phase === "failed" ? state.mutation.failure : null;
  const updateFailed = state.mutation.phase === "failed" && state.mutation.action === "update";
  const openFailed = state.mutation.phase === "failed" && state.mutation.action === "open";

  return (
    <section
      className="workbench project-workbench"
      aria-labelledby="projects-heading"
      aria-busy={loadBusy || mutationBusy}
    >
      <div className="workbench-intro">
        <div>
          <p className="eyebrow">{t("projects.kicker")}</p>
          <h1 id="projects-heading">{t("projects.heading")}</h1>
          <p>{t("projects.description")}</p>
        </div>
      </div>

      {state.loadPhase === "disabled" ? (
        <section className="surface project-notice" aria-live="polite">
          <div className="project-notice-copy">
            <span className="status-mark" aria-hidden="true" />
            <div>
              <h2>{t("projects.disabled.title")}</h2>
              <p>{t("projects.disabled.body")}</p>
            </div>
          </div>
        </section>
      ) : (
        <div className="project-stack">
          <AddProjectForm
            disabled={!canMutate}
            isAdding={state.mutation.phase === "adding"}
            knownProfiles={state.knownProfiles}
            onAdd={addProject}
            t={t}
          />

          {state.loadFailure === null ? null : (
            <FailureNotice
              failure={state.loadFailure}
              title={t("projects.error.loadTitle")}
              actionLabel={t("projects.retry")}
              onAction={refresh}
              t={t}
            />
          )}

          {mutationFailure === null ? null : (
            <FailureNotice
              failure={mutationFailure}
              title={t(
                openFailed
                  ? "projects.error.openEditorTitle"
                  : updateFailed
                    ? "projects.error.updateTitle"
                    : "projects.error.addTitle",
              )}
              actionLabel={t(updateFailed ? "projects.retry" : "projects.dismiss")}
              onAction={
                updateFailed
                  ? () => {
                      clearFeedback();
                      refresh();
                    }
                  : clearFeedback
              }
              t={t}
            />
          )}

          {state.editorOpenedProjectId === null ? null : (
            <section className="surface project-warning" role="status" aria-live="polite">
              <div className="section-heading">
                <div>
                  <h2>{t("project.editor.openedTitle")}</h2>
                  <p>{t("project.editor.openedBody")}</p>
                </div>
                <button className="text-button" type="button" onClick={clearFeedback}>
                  {t("projects.dismiss")}
                </button>
              </div>
            </section>
          )}

          <AddDiagnostics diagnostics={state.addDiagnostics} onDismiss={clearFeedback} t={t} />

          {loadBusy && state.projects.length === 0 ? (
            <section className="surface project-notice" aria-live="polite">
              <div className="project-notice-copy">
                <span className="button-spinner project-spinner" aria-hidden="true" />
                <div>
                  <h2>{t("projects.loading.title")}</h2>
                  <p>{t("projects.loading.body")}</p>
                </div>
              </div>
            </section>
          ) : null}

          {state.loadPhase === "ready" && state.projects.length === 0 ? (
            <section className="surface project-empty">
              <h2>{t("projects.empty.title")}</h2>
              <p>{t("projects.empty.body")}</p>
            </section>
          ) : null}

          {state.projects.length === 0 ? null : (
            <section aria-labelledby="project-list-heading">
              <div className="project-list-heading">
                <h2 id="project-list-heading">{t("projects.listHeading")}</h2>
                <span className="count-badge" aria-hidden="true">
                  {state.projects.length}
                </span>
              </div>
              <ul className="project-list">
                {state.projects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    locale={locale}
                    mutation={state.mutation}
                    disabled={state.loadPhase !== "ready"}
                    knownProfiles={state.knownProfiles}
                    onUpdate={updateProjectBinding}
                    onOpen={openProjectInCursor}
                    t={t}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  );
}

export function ProjectWorkbench({ enabled, locale, t }: ProjectWorkbenchProps) {
  const controller = useProjects(enabled);
  return (
    <ProjectWorkbenchView
      state={controller.state}
      locale={locale}
      t={t}
      refresh={controller.refresh}
      addProject={controller.addProject}
      updateProjectBinding={controller.updateProjectBinding}
      openProjectInCursor={controller.openProjectInCursor}
      clearFeedback={controller.clearFeedback}
    />
  );
}
