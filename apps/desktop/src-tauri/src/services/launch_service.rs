use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::adapters::omp::{OmpAdapter, OmpModel};
use crate::adapters::targets::ExecutionTarget;
use crate::domain::{
    AccountPolicy, ClosePtyRunRequest, CredentialPolicy, DomainError, ExecutableIdentityEvidence,
    ExecuteLaunchPlanRequest, ExternalTerminalLaunch, LaunchAction, LaunchEnvironmentSource,
    LaunchEnvironmentSummary, LaunchExecutionResult, LaunchModel, LaunchOptions,
    LaunchOptionsRequest, LaunchPlan, LaunchPlanInput, PrepareLaunchPlanRequest,
    PreparedLaunchPlan, ProjectSessionPreviewRequest, PtyOutputBatch, PtyRunSnapshot,
    ReadPtyOutputRequest, ResizePtyRequest, SettingSource, TerminalMode, TerminatePtyRequest,
    WritePtyInputRequest, LAUNCH_MODEL_ROLES,
};
use crate::infrastructure::process::{
    external_terminal_environment_names, inspect_executable_file, omp_runtime_environment_names,
    provider_credential_environment_names,
};
use crate::infrastructure::pty::{PtyEventSink, PtyRuntime};
use crate::infrastructure::secrets::redact;

use super::project_service::ProjectLaunchContext;
use super::session_service::SessionLaunchContext;
use super::{ProjectService, SessionService, TaskSupervisor};

const PLAN_TTL: Duration = Duration::from_secs(120);
const MAXIMUM_PLANS: usize = 128;
const MAXIMUM_MODEL_OPTIONS: usize = 4_096;

#[derive(Clone)]
pub struct LaunchService {
    projects: ProjectService,
    sessions: SessionService,
    supervisor: TaskSupervisor,
    omp: Arc<dyn OmpAdapter>,
    target: Arc<dyn ExecutionTarget>,
    pty: PtyRuntime,
    plans: Arc<Mutex<PlanRegistry>>,
    model_query_active: Arc<AtomicBool>,
    fingerprint_salt: Uuid,
}

#[derive(Default)]
struct PlanRegistry {
    plans: HashMap<String, StoredPlan>,
}

#[derive(Clone)]
struct StoredPlan {
    public: PreparedLaunchPlan,
    plan: LaunchPlan,
    environment_evidence: Vec<EnvironmentEvidence>,
    project_identity_json: String,
    project_path: PathBuf,
    executable_identity: ExecutableIdentityEvidence,
    session: Option<StoredSessionEvidence>,
    expires_at_monotonic: Instant,
    state: StoredPlanState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EnvironmentSource {
    ManagerProcess,
}

#[derive(Clone, PartialEq, Eq)]
struct EnvironmentEvidence {
    name: String,
    source: EnvironmentSource,
    value_fingerprint: Option<String>,
}

struct LaunchFingerprintEvidence<'a> {
    project_id: i64,
    binding_revision: u64,
    project_identity: &'a str,
    executable_identity: &'a ExecutableIdentityEvidence,
    session: Option<&'a SessionLaunchContext>,
    environment: &'a [EnvironmentEvidence],
}

struct ModelQueryPermit {
    active: Arc<AtomicBool>,
}

impl ModelQueryPermit {
    fn acquire(active: &Arc<AtomicBool>) -> Option<Self> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self {
                active: Arc::clone(active),
            })
    }
}

impl Drop for ModelQueryPermit {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoredPlanState {
    Prepared,
    Consumed,
}

#[derive(Clone)]
struct StoredSessionEvidence {
    session_index_id: i64,
    session_id: String,
    session_path: PathBuf,
    source_identity_json: String,
    source_size_bytes: u64,
    source_modified_at_epoch_ms: u64,
}

struct ResolvedLaunch {
    project: ProjectLaunchContext,
    session: Option<SessionLaunchContext>,
    installation: crate::domain::OmpInstallation,
    executable_identity: ExecutableIdentityEvidence,
    options: LaunchOptions,
    supported_model_roles: HashSet<&'static str>,
    thinking_supported: bool,
}

impl std::fmt::Debug for LaunchService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let plan_count = self.plans.lock().map(|plans| plans.plans.len()).ok();
        formatter
            .debug_struct("LaunchService")
            .field("plan_count", &plan_count)
            .field("pty", &self.pty)
            .finish_non_exhaustive()
    }
}

impl LaunchService {
    pub fn new(
        projects: ProjectService,
        sessions: SessionService,
        supervisor: TaskSupervisor,
        omp: Arc<dyn OmpAdapter>,
        target: Arc<dyn ExecutionTarget>,
        pty: PtyRuntime,
    ) -> Self {
        Self {
            projects,
            sessions,
            supervisor,
            omp,
            target,
            pty,
            plans: Arc::new(Mutex::new(PlanRegistry::default())),
            model_query_active: Arc::new(AtomicBool::new(false)),
            fingerprint_salt: Uuid::new_v4(),
        }
    }

    pub async fn options(
        &self,
        request: LaunchOptionsRequest,
    ) -> Result<LaunchOptions, DomainError> {
        Ok(self.resolve_launch(request, true).await?.options)
    }

    pub async fn prepare(
        &self,
        request: PrepareLaunchPlanRequest,
    ) -> Result<PreparedLaunchPlan, DomainError> {
        let resolved = self
            .resolve_launch(
                LaunchOptionsRequest {
                    project_id: request.project_id,
                    expected_binding_revision: request.expected_binding_revision,
                    action: request.action,
                    session_index_id: request.session_index_id,
                },
                true,
            )
            .await?;
        validate_model_roles(
            &request.model_roles,
            &resolved.options.model_roles,
            &resolved.options.available_models,
        )?;
        validate_thinking_level(request.thinking_level.as_deref())?;
        validate_model_thinking_level(
            request.model_roles.get("default").map(String::as_str),
            request.thinking_level.as_deref(),
            &resolved.options.available_models,
        )?;
        validate_override_capabilities(
            &request.model_roles,
            request.thinking_level.as_deref(),
            &resolved.supported_model_roles,
            resolved.thinking_supported,
        )?;

        let session_path = resolved
            .session
            .as_ref()
            .map(|session| session.session_path.clone());
        let args = build_launch_arguments(
            &resolved.options.profile,
            &resolved.project.canonical_path,
            request.action,
            session_path.as_deref(),
            &request.model_roles,
            request.thinking_level.as_deref(),
        )?;
        let credential_policy = resolved.options.credential_policy.clone();
        let terminal_mode = resolved.options.terminal_mode;
        let env_allowlist = build_launch_environment_allowlist(
            &credential_policy,
            &request.model_roles,
            terminal_mode,
        );
        let environment_evidence =
            capture_environment_evidence(self.fingerprint_salt.as_bytes(), &env_allowlist);
        let display_preview_redacted = display_preview(
            &resolved.options.profile,
            request.action,
            &request.model_roles,
            request.thinking_level.as_deref(),
        );
        let mut setting_sources = resolved.options.setting_sources.clone();
        for role in request.model_roles.keys() {
            setting_sources.insert(format!("model_roles.{role}"), SettingSource::LaunchOverride);
        }
        if request.thinking_level != resolved.options.thinking_level {
            setting_sources.insert("thinking_level".to_owned(), SettingSource::LaunchOverride);
        }
        let plan = self
            .omp
            .build_launch_plan(LaunchPlanInput {
                target_id: "local".to_owned(),
                omp_executable: PathBuf::from(&resolved.installation.executable_path),
                cwd: resolved.project.canonical_path.clone(),
                profile: resolved.options.profile.clone(),
                action: request.action,
                session_ref: resolved
                    .session
                    .as_ref()
                    .map(|session| session.preview.session_id.clone()),
                model_roles: request.model_roles.clone(),
                thinking_level: request.thinking_level.clone(),
                credential_policy: credential_policy.clone(),
                terminal_mode,
                args,
                env_allowlist,
                temporary_config: None,
                display_preview_redacted: display_preview_redacted.clone(),
                warnings: resolved.options.warnings.clone(),
                setting_sources: setting_sources.clone(),
            })
            .await?;
        let executable_identity = resolved.executable_identity.clone();
        let created_at_epoch_ms = epoch_millis();
        let expires_at_epoch_ms = created_at_epoch_ms
            .saturating_add(PLAN_TTL.as_millis().min(u128::from(u64::MAX)) as u64);
        let expires_at_monotonic = Instant::now() + PLAN_TTL;
        let input_fingerprint = launch_fingerprint(
            self.fingerprint_salt.as_bytes(),
            &plan,
            LaunchFingerprintEvidence {
                project_id: request.project_id,
                binding_revision: request.expected_binding_revision,
                project_identity: &resolved.project.stable_identity_json,
                executable_identity: &executable_identity,
                session: resolved.session.as_ref(),
                environment: &environment_evidence,
            },
        );
        let plan_id = Uuid::new_v4().to_string();
        let public = PreparedLaunchPlan {
            plan_id: plan_id.clone(),
            input_fingerprint,
            created_at_epoch_ms,
            expires_at_epoch_ms,
            project_id: request.project_id,
            binding_revision: request.expected_binding_revision,
            action: request.action,
            session_index_id: request.session_index_id,
            session_id: resolved
                .session
                .as_ref()
                .map(|session| session.preview.session_id.clone()),
            profile: resolved.options.profile,
            cwd_display: resolved.options.cwd_display,
            model_roles: request.model_roles,
            thinking_level: request.thinking_level,
            credential_policy,
            terminal_mode,
            display_preview_redacted,
            environment: environment_evidence
                .iter()
                .map(|evidence| LaunchEnvironmentSummary {
                    name: evidence.name.clone(),
                    source: LaunchEnvironmentSource::ManagerProcess,
                    present: evidence.value_fingerprint.is_some(),
                })
                .collect(),
            warnings: resolved.options.warnings,
            setting_sources,
        };
        let session = resolved.session.map(|session| StoredSessionEvidence {
            session_index_id: session.preview.session_index_id,
            session_id: session.preview.session_id,
            session_path: session.session_path,
            source_identity_json: session.source_identity_json,
            source_size_bytes: session.preview.source_size_bytes,
            source_modified_at_epoch_ms: session.preview.source_modified_at_epoch_ms,
        });
        let stored = StoredPlan {
            public: public.clone(),
            plan,
            environment_evidence,
            project_identity_json: resolved.project.stable_identity_json,
            project_path: resolved.project.canonical_path,
            executable_identity,
            session,
            expires_at_monotonic,
            state: StoredPlanState::Prepared,
        };
        let mut plans = self.lock_plans()?;
        prune_plans(&mut plans);
        if plans.plans.len() >= MAXIMUM_PLANS {
            return Err(launch_error(
                "launch_plan_limit_reached",
                "待处理的启动预览数量已达到上限。",
                "等待旧预览过期后重试。",
                true,
                "plan registry reached its bounded capacity",
            ));
        }
        plans.plans.insert(plan_id, stored);
        Ok(public)
    }

    pub async fn execute(
        &self,
        request: ExecuteLaunchPlanRequest,
        sink: Arc<dyn PtyEventSink>,
    ) -> Result<LaunchExecutionResult, DomainError> {
        validate_plan_id(&request.plan_id)?;
        let stored = {
            let mut plans = self.lock_plans()?;
            let stored = plans.plans.get_mut(&request.plan_id).ok_or_else(|| {
                launch_error(
                    "launch_plan_not_found",
                    "找不到该启动预览。",
                    "重新生成启动预览。",
                    false,
                    "plan id was absent",
                )
            })?;
            if stored.state != StoredPlanState::Prepared {
                return Err(launch_error(
                    "launch_plan_already_used",
                    "该启动预览已经执行或失效。",
                    "重新生成启动预览，避免重复启动。",
                    false,
                    "plan state was not prepared",
                ));
            }
            if Instant::now() > stored.expires_at_monotonic {
                stored.state = StoredPlanState::Consumed;
                return Err(launch_error(
                    "launch_plan_expired",
                    "启动预览已经过期。",
                    "重新生成预览以复核项目、会话和 OMP 安装。",
                    true,
                    "plan exceeded its two-minute lifetime",
                ));
            }
            stored.state = StoredPlanState::Consumed;
            stored.clone()
        };
        self.revalidate_and_start(stored, sink).await
    }

    pub fn list_runs(&self) -> Result<Vec<PtyRunSnapshot>, DomainError> {
        self.pty.list_runs()
    }

    pub fn read_output(
        &self,
        request: ReadPtyOutputRequest,
    ) -> Result<PtyOutputBatch, DomainError> {
        self.pty
            .read_output(&request.run_id, request.after_sequence)
    }

    pub fn write_input(&self, request: WritePtyInputRequest) -> Result<(), DomainError> {
        self.pty.write_input(request)
    }

    pub fn resize(&self, request: ResizePtyRequest) -> Result<PtyRunSnapshot, DomainError> {
        self.pty.resize(request)
    }

    pub fn terminate(&self, request: TerminatePtyRequest) -> Result<PtyRunSnapshot, DomainError> {
        self.pty.terminate(request)
    }

    pub fn close_run(&self, request: ClosePtyRunRequest) -> Result<(), DomainError> {
        self.pty.close_run(request)
    }

    async fn resolve_launch(
        &self,
        request: LaunchOptionsRequest,
        include_models: bool,
    ) -> Result<ResolvedLaunch, DomainError> {
        validate_launch_scope(
            request.action,
            request.session_index_id,
            request.project_id,
            request.expected_binding_revision,
        )?;
        let project = self
            .projects
            .launch_context(request.project_id, request.expected_binding_revision)
            .await?;
        let report = self.supervisor.latest_probe_report()?.ok_or_else(|| {
            launch_error(
                "launch_probe_required",
                "尚无可用于启动的 OMP 探测结果。",
                "先完成一次 OMP 检测。",
                true,
                "latest successful probe report was absent",
            )
        })?;
        let probe_executable_identity = report.executable_identity.clone().ok_or_else(|| {
            launch_error(
                "launch_probe_identity_unavailable",
                "OMP 检测结果缺少完整的可执行文件身份。",
                "重新检测 OMP 后再启动。",
                true,
                "probe report did not include digest-backed executable identity",
            )
        })?;
        let installation = report.installation.ok_or_else(|| {
            launch_error(
                "launch_omp_unavailable",
                "没有可用的 OMP 安装。",
                "安装或选择 OMP 后重新检测。",
                true,
                "probe report did not include an installation",
            )
        })?;
        require_capability(&report.capabilities, "profile")?;
        require_capability(&report.capabilities, "cwd")?;
        if request.action == LaunchAction::Resume {
            require_capability(&report.capabilities, "session_resume")?;
        }
        let supported_model_roles = LAUNCH_MODEL_ROLES
            .iter()
            .copied()
            .filter(|role| capability_available(&report.capabilities, model_role_capability(role)))
            .collect::<HashSet<_>>();
        let thinking_supported = capability_available(&report.capabilities, "thinking");
        let executable_identity = inspect_executable(Path::new(&installation.executable_path))?;
        if executable_identity != probe_executable_identity {
            return Err(launch_error(
                "launch_omp_binary_changed",
                "OMP 可执行文件在检测后发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "digest-backed executable identity did not match probe evidence",
            ));
        }

        let session = match request.session_index_id {
            Some(session_index_id) => Some(
                self.sessions
                    .launch_context(ProjectSessionPreviewRequest {
                        project_id: request.project_id,
                        session_index_id,
                    })
                    .await?,
            ),
            None => None,
        };
        let mut warnings = Vec::new();
        let mut model_roles = project
            .project
            .binding
            .role_defaults
            .iter()
            .filter_map(|(role, selector)| {
                if supported_model_roles.contains(role.as_str()) {
                    Some((role.clone(), selector.clone()))
                } else {
                    if !warnings
                        .iter()
                        .any(|warning| warning == "launch_roles_unsupported")
                    {
                        warnings.push("launch_roles_unsupported".to_owned());
                    }
                    None
                }
            })
            .collect::<BTreeMap<_, _>>();
        let mut setting_sources = model_roles
            .keys()
            .map(|role| (format!("model_roles.{role}"), SettingSource::Project))
            .collect::<BTreeMap<_, _>>();
        let mut thinking_level = None;
        if let Some(session) = &session {
            for (role, selector) in &session.preview.model_roles {
                if supported_model_roles.contains(role.as_str()) {
                    model_roles.insert(role.clone(), selector.clone());
                    setting_sources.insert(format!("model_roles.{role}"), SettingSource::Session);
                } else if !warnings
                    .iter()
                    .any(|warning| warning == "launch_roles_unsupported")
                {
                    warnings.push("launch_roles_unsupported".to_owned());
                }
            }
            if let Some(selector) = &session.preview.model_selector {
                model_roles
                    .entry("default".to_owned())
                    .or_insert_with(|| selector.clone());
                setting_sources
                    .entry("model_roles.default".to_owned())
                    .or_insert(SettingSource::Session);
            }
            thinking_level = thinking_supported
                .then_some(session.preview.thinking_level.as_ref())
                .flatten()
                .filter(|value| is_supported_thinking_level(value))
                .cloned();
            if thinking_level.is_some() {
                setting_sources.insert("thinking_level".to_owned(), SettingSource::Session);
            } else if session.preview.thinking_level.is_some() {
                warnings.push("launch_thinking_unsupported".to_owned());
            }
        }
        let credential_policy = match project.project.binding.account_policy {
            AccountPolicy::Automatic => CredentialPolicy::Automatic,
            AccountPolicy::Profile => CredentialPolicy::Profile,
            AccountPolicy::CredentialPin => {
                return Err(launch_error(
                    "launch_credential_pin_unavailable",
                    "当前 OMP 版本无法安全固定具体凭证。",
                    "改用自动选择或固定 Profile。",
                    false,
                    "credential pin reached launch resolution",
                ));
            }
        };
        setting_sources.insert("profile".to_owned(), SettingSource::Project);
        setting_sources.insert("credential_policy".to_owned(), SettingSource::Project);
        setting_sources.insert("terminal_mode".to_owned(), SettingSource::Project);
        let terminal_mode = project.project.binding.terminal_mode;
        if terminal_mode == TerminalMode::External {
            warnings.push("launch_external_terminal_detached".to_owned());
        }

        let available_models = if include_models
            && report
                .capabilities
                .iter()
                .any(|capability| capability.id == "models_json" && capability.available)
        {
            match ModelQueryPermit::acquire(&self.model_query_active) {
                Some(_permit) => {
                    warnings.push("launch_models_isolated_inventory".to_owned());
                    match self
                        .omp
                        .list_models(
                            &installation,
                            &executable_identity,
                            &project.project.binding.profile,
                            &project.canonical_path,
                        )
                        .await
                    {
                        Ok(models) => filter_models(models, &project.project, &mut warnings)?,
                        Err(_) => {
                            warnings.push("launch_models_unavailable".to_owned());
                            Vec::new()
                        }
                    }
                }
                None => {
                    warnings.push("launch_models_busy".to_owned());
                    Vec::new()
                }
            }
        } else {
            warnings.push("launch_models_capability_unavailable".to_owned());
            Vec::new()
        };
        if inspect_executable(Path::new(&installation.executable_path))? != executable_identity {
            return Err(launch_error(
                "launch_omp_binary_changed",
                "OMP 可执行文件在模型查询期间发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "executable identity changed during isolated model query",
            ));
        }
        let options = LaunchOptions {
            project_id: request.project_id,
            binding_revision: request.expected_binding_revision,
            action: request.action,
            session_index_id: request.session_index_id,
            session_id: session
                .as_ref()
                .map(|value| value.preview.session_id.clone()),
            profile: project.project.binding.profile.clone(),
            cwd_display: project.project.display_path.clone(),
            model_roles,
            thinking_level,
            credential_policy,
            terminal_mode,
            available_models,
            warnings,
            setting_sources,
        };
        Ok(ResolvedLaunch {
            project,
            session,
            installation,
            executable_identity,
            options,
            supported_model_roles,
            thinking_supported,
        })
    }

    async fn revalidate_and_start(
        &self,
        stored: StoredPlan,
        sink: Arc<dyn PtyEventSink>,
    ) -> Result<LaunchExecutionResult, DomainError> {
        let report = self.supervisor.latest_probe_report()?.ok_or_else(|| {
            launch_error(
                "launch_probe_changed",
                "OMP 能力证据在预览后不可用。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "latest successful probe report was absent at execution",
            )
        })?;
        if report.target_id != stored.plan.target_id() {
            return Err(launch_error(
                "launch_probe_changed",
                "OMP 执行目标在预览后发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "probe target did not match the prepared plan",
            ));
        }
        require_capability(&report.capabilities, "profile")?;
        require_capability(&report.capabilities, "cwd")?;
        if stored.plan.action() == LaunchAction::Resume {
            require_capability(&report.capabilities, "session_resume")?;
        }
        for role in stored.plan.model_roles().keys() {
            require_capability(&report.capabilities, model_role_capability(role))?;
        }
        if stored.plan.thinking_level().is_some() {
            require_capability(&report.capabilities, "thinking")?;
        }
        if report.executable_identity.as_ref() != Some(&stored.executable_identity) {
            return Err(launch_error(
                "launch_probe_changed",
                "OMP 文件身份证据在预览后发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "latest probe digest-backed identity differed from the prepared plan",
            ));
        }
        let current_installation = report.installation.ok_or_else(|| {
            launch_error(
                "launch_probe_changed",
                "OMP 安装证据在预览后发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "latest probe report did not contain an installation",
            )
        })?;
        let current_probe_identity =
            inspect_executable(Path::new(&current_installation.executable_path))?;
        if current_probe_identity != stored.executable_identity {
            return Err(launch_error(
                "launch_probe_changed",
                "当前 OMP 安装与启动预览不再一致。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "latest probe executable identity differed from the prepared plan",
            ));
        }
        let current_environment = capture_environment_evidence(
            self.fingerprint_salt.as_bytes(),
            stored.plan.env_allowlist(),
        );
        if current_environment != stored.environment_evidence {
            return Err(launch_error(
                "launch_environment_changed",
                "OMP 启动环境在预览后发生变化。",
                "重新生成启动预览以确认当前凭证和配置来源。",
                true,
                "allow-listed environment presence or value changed after preview",
            ));
        }
        let project = self
            .projects
            .launch_context(stored.public.project_id, stored.public.binding_revision)
            .await?;
        if project.canonical_path != stored.project_path
            || project.stable_identity_json != stored.project_identity_json
        {
            return Err(launch_error(
                "launch_project_changed",
                "项目目录在预览后发生变化。",
                "刷新项目并重新生成启动预览。",
                true,
                "project path or stable identity changed",
            ));
        }
        let session_launch_context = if let Some(expected) = &stored.session {
            let current = self
                .sessions
                .launch_context(ProjectSessionPreviewRequest {
                    project_id: stored.public.project_id,
                    session_index_id: expected.session_index_id,
                })
                .await?;
            if current.session_path != expected.session_path
                || current.source_identity_json != expected.source_identity_json
                || current.preview.session_id != expected.session_id
                || current.preview.source_size_bytes != expected.source_size_bytes
                || current.preview.source_modified_at_epoch_ms
                    != expected.source_modified_at_epoch_ms
            {
                return Err(launch_error(
                    "launch_session_changed",
                    "会话文件在预览后发生变化。",
                    "重新扫描会话并生成新的启动预览。",
                    true,
                    "session path, identity, size, or modified time changed",
                ));
            }
            Some(current)
        } else {
            None
        };
        let title = stored
            .session
            .as_ref()
            .map(|session| session.session_id.clone())
            .unwrap_or_else(|| project.project.display_path.clone());
        let result = match stored.plan.terminal_mode() {
            TerminalMode::Embedded => self
                .pty
                .start_omp(
                    stored.plan,
                    stored.executable_identity,
                    stored.public.project_id,
                    title,
                    sink,
                )
                .map(|run| LaunchExecutionResult::Embedded { run }),
            TerminalMode::External => {
                let process = self
                    .target
                    .open_external_terminal(&stored.plan, &stored.executable_identity)
                    .await?;
                Ok(LaunchExecutionResult::External {
                    launch: ExternalTerminalLaunch {
                        terminal_id: process.terminal_id,
                        process_id: process.process_id,
                        project_id: stored.public.project_id,
                        action: stored.public.action,
                        session_id: stored.public.session_id,
                        profile: stored.public.profile,
                        model_roles: stored.public.model_roles,
                        thinking_level: stored.public.thinking_level,
                        launched_at_epoch_ms: epoch_millis(),
                    },
                })
            }
        };
        drop(session_launch_context);
        drop(project);
        result
    }

    fn lock_plans(&self) -> Result<MutexGuard<'_, PlanRegistry>, DomainError> {
        self.plans.lock().map_err(|_| {
            launch_error(
                "launch_plan_registry_poisoned",
                "启动预览注册表不可用。",
                "重新启动应用后重试。",
                false,
                "plan registry mutex was poisoned",
            )
        })
    }
}

fn validate_launch_scope(
    action: LaunchAction,
    session_index_id: Option<i64>,
    project_id: i64,
    binding_revision: u64,
) -> Result<(), DomainError> {
    if !(1..=9_007_199_254_740_991).contains(&project_id) {
        return Err(launch_error(
            "launch_project_id_invalid",
            "启动请求中的项目标识无效。",
            "刷新项目列表后重试。",
            false,
            "project id was outside the safe range",
        ));
    }
    if binding_revision == 0 || binding_revision > i64::MAX as u64 {
        return Err(launch_error(
            "launch_binding_revision_invalid",
            "启动请求中的绑定版本无效。",
            "刷新项目列表后重试。",
            false,
            "binding revision was outside the safe range",
        ));
    }
    match (action, session_index_id) {
        (LaunchAction::New, None) => Ok(()),
        (LaunchAction::Resume, Some(id)) if id > 0 && id <= 9_007_199_254_740_991 => Ok(()),
        (LaunchAction::Fork | LaunchAction::Export, _) => Err(launch_error(
            "launch_action_unavailable",
            "当前里程碑仅支持新建和恢复 OMP 会话。",
            "选择新建或恢复；分叉和导出将在后续里程碑开放。",
            false,
            "fork or export was requested",
        )),
        _ => Err(launch_error(
            "launch_session_scope_invalid",
            "启动动作与会话标识不匹配。",
            "刷新项目会话列表后重试。",
            false,
            "new included a session id or resume omitted one",
        )),
    }
}

fn require_capability(
    capabilities: &[crate::domain::Capability],
    id: &str,
) -> Result<(), DomainError> {
    if capability_available(capabilities, id) {
        return Ok(());
    }
    Err(launch_error(
        "launch_capability_unavailable",
        "当前 OMP 安装缺少启动所需能力。",
        "重新检测 OMP；若仍不可用，请升级到受支持版本。",
        false,
        &format!("required capability was unavailable: {id}"),
    ))
}

fn capability_available(capabilities: &[crate::domain::Capability], id: &str) -> bool {
    capabilities
        .iter()
        .any(|capability| capability.id == id && capability.available)
}

fn model_role_capability(role: &str) -> &'static str {
    match role {
        "default" => "model_default",
        "smol" => "model_smol",
        "slow" => "model_slow",
        "plan" => "model_plan",
        _ => "model_role_unknown",
    }
}

fn validate_model_roles(
    requested: &BTreeMap<String, String>,
    inherited: &BTreeMap<String, String>,
    available: &[LaunchModel],
) -> Result<(), DomainError> {
    if requested.len() > LAUNCH_MODEL_ROLES.len() {
        return Err(invalid_model_override("too many model roles"));
    }
    for (role, selector) in requested {
        if !LAUNCH_MODEL_ROLES.contains(&role.as_str())
            || selector.len() > 768
            || selector.contains('\0')
            || selector
                .split_once('/')
                .is_none_or(|(provider, model)| provider.is_empty() || model.is_empty())
        {
            return Err(invalid_model_override("role or selector was invalid"));
        }
        let known = available.iter().any(|model| model.selector == *selector)
            || inherited.get(role) == Some(selector);
        if !known {
            return Err(invalid_model_override(
                "selector was not present in the bounded model inventory",
            ));
        }
    }
    Ok(())
}

fn validate_override_capabilities(
    model_roles: &BTreeMap<String, String>,
    thinking_level: Option<&str>,
    supported_model_roles: &HashSet<&'static str>,
    thinking_supported: bool,
) -> Result<(), DomainError> {
    if let Some(role) = model_roles
        .keys()
        .find(|role| !supported_model_roles.contains(role.as_str()))
    {
        return Err(launch_error(
            "launch_capability_unavailable",
            "当前 OMP 安装不支持所选模型角色覆盖。",
            "重新检测 OMP，或清除该角色覆盖后生成预览。",
            false,
            &format!(
                "required capability was unavailable: {}",
                model_role_capability(role)
            ),
        ));
    }
    if thinking_level.is_some() && !thinking_supported {
        return Err(launch_error(
            "launch_capability_unavailable",
            "当前 OMP 安装不支持思考等级启动参数。",
            "重新检测 OMP，或清除思考等级覆盖后生成预览。",
            false,
            "required capability was unavailable: thinking",
        ));
    }
    Ok(())
}

fn invalid_model_override(detail: &str) -> DomainError {
    launch_error(
        "launch_model_override_invalid",
        "启动模型覆盖无效或不在当前可用列表中。",
        "从模型列表重新选择，或保留 OMP 默认设置。",
        false,
        detail,
    )
}

fn validate_thinking_level(value: Option<&str>) -> Result<(), DomainError> {
    if value.is_none_or(is_supported_thinking_level) {
        return Ok(());
    }
    Err(launch_error(
        "launch_thinking_level_invalid",
        "启动思考等级无效。",
        "选择 OMP 支持的思考等级。",
        false,
        "thinking level was outside the fixed allowlist",
    ))
}

fn validate_model_thinking_level(
    default_model: Option<&str>,
    thinking_level: Option<&str>,
    available_models: &[LaunchModel],
) -> Result<(), DomainError> {
    let (Some(selector), Some(level)) = (default_model, thinking_level) else {
        return Ok(());
    };
    if level == "off" {
        return Ok(());
    }
    let Some(model) = available_models
        .iter()
        .find(|model| model.selector == selector)
    else {
        return Ok(());
    };
    if model.thinking.iter().any(|supported| supported == level) {
        return Ok(());
    }
    Err(launch_error(
        "launch_thinking_model_unsupported",
        "所选模型未声明支持该思考等级。",
        "选择模型支持的思考等级，或让 OMP 使用继承设置。",
        false,
        "thinking level was absent from the selected model capability list",
    ))
}

fn is_supported_thinking_level(value: &str) -> bool {
    matches!(
        value,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto"
    )
}

fn build_launch_environment_allowlist(
    credential_policy: &CredentialPolicy,
    model_roles: &BTreeMap<String, String>,
    terminal_mode: TerminalMode,
) -> Vec<String> {
    let mut names = omp_runtime_environment_names()
        .iter()
        .copied()
        .filter(|name| !matches!(*name, "TERM" | "COLORTERM"))
        .collect::<BTreeSet<_>>();
    if terminal_mode == TerminalMode::External {
        names.extend(external_terminal_environment_names());
    }
    if credential_policy == &CredentialPolicy::Automatic {
        for selector in model_roles.values() {
            let Some((provider, _)) = selector.split_once('/') else {
                continue;
            };
            names.extend(provider_credential_environment_names(provider));
        }
    }
    names.into_iter().map(str::to_owned).collect()
}

fn build_launch_arguments(
    profile: &str,
    cwd: &Path,
    action: LaunchAction,
    session_path: Option<&Path>,
    model_roles: &BTreeMap<String, String>,
    thinking_level: Option<&str>,
) -> Result<Vec<String>, DomainError> {
    let cwd = cwd.to_str().ok_or_else(|| {
        launch_error(
            "launch_project_path_encoding_unsupported",
            "项目路径无法无损传给当前 OMP 启动器。",
            "使用可由操作系统 UTF-8 表示的项目路径。",
            false,
            "project path was not valid UTF-8",
        )
    })?;
    let mut args = vec![
        "--profile".to_owned(),
        profile.to_owned(),
        "--cwd".to_owned(),
        cwd.to_owned(),
    ];
    for role in LAUNCH_MODEL_ROLES {
        if let Some(selector) = model_roles.get(*role) {
            let flag = match *role {
                "default" => "--model",
                "smol" => "--smol",
                "slow" => "--slow",
                "plan" => "--plan",
                _ => unreachable!("roles are a closed constant"),
            };
            args.push(flag.to_owned());
            args.push(selector.clone());
        }
    }
    if let Some(thinking_level) = thinking_level {
        args.push("--thinking".to_owned());
        args.push(thinking_level.to_owned());
    }
    if action == LaunchAction::Resume {
        let session_path = session_path.and_then(Path::to_str).ok_or_else(|| {
            launch_error(
                "launch_session_path_encoding_unsupported",
                "会话路径无法无损传给当前 OMP 启动器。",
                "重新扫描位于 UTF-8 路径中的会话。",
                false,
                "resume session path was missing or not valid UTF-8",
            )
        })?;
        args.push("--resume".to_owned());
        args.push(session_path.to_owned());
    }
    Ok(args)
}

fn display_preview(
    profile: &str,
    action: LaunchAction,
    model_roles: &BTreeMap<String, String>,
    thinking_level: Option<&str>,
) -> String {
    let mut values = vec![
        "omp".to_owned(),
        "--profile".to_owned(),
        profile.to_owned(),
        "--cwd".to_owned(),
        "[project]".to_owned(),
    ];
    for role in LAUNCH_MODEL_ROLES {
        if let Some(selector) = model_roles.get(*role) {
            values.push(format!("{role}={selector}"));
        }
    }
    if let Some(level) = thinking_level {
        values.push(format!("thinking={level}"));
    }
    if action == LaunchAction::Resume {
        values.push("--resume".to_owned());
        values.push("[authorized-session]".to_owned());
    }
    values.join(" ")
}

fn filter_models(
    models: Vec<OmpModel>,
    project: &crate::domain::ProjectSummary,
    warnings: &mut Vec<String>,
) -> Result<Vec<LaunchModel>, DomainError> {
    if models.len() > MAXIMUM_MODEL_OPTIONS {
        return Err(launch_error(
            "launch_model_count_exceeded",
            "可用模型数量超过管理器的安全上限。",
            "减少自定义模型数量后重试。",
            false,
            "adapter returned more than 4096 models",
        ));
    }
    let allowed_models = &project.binding.allowed_models;
    let disabled_providers = &project.binding.disabled_providers;
    let filtered = models
        .into_iter()
        .filter(|model| {
            !disabled_providers.contains(&model.provider)
                && (allowed_models.is_empty() || allowed_models.contains(&model.selector))
        })
        .map(|model| LaunchModel {
            provider: model.provider,
            id: model.id,
            selector: model.selector,
            name: model.name,
            context_window: model.context_window,
            max_tokens: model.max_tokens,
            reasoning: model.reasoning,
            thinking: model.thinking.unwrap_or_default(),
            input: model.input,
        })
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        warnings.push("launch_models_empty".to_owned());
    }
    Ok(filtered)
}

fn inspect_executable(path: &Path) -> Result<ExecutableIdentityEvidence, DomainError> {
    inspect_executable_file(path).map_err(|error| {
        launch_error(
            "launch_omp_identity_unavailable",
            "无法验证 OMP 可执行文件的完整身份。",
            "检查路径、权限或文件大小后重新检测 OMP。",
            true,
            &redact(&error.to_string()),
        )
    })
}

fn launch_fingerprint(
    salt: &[u8],
    plan: &LaunchPlan,
    evidence: LaunchFingerprintEvidence<'_>,
) -> String {
    let mut hasher = Sha256::new();
    update_fingerprint(&mut hasher, salt);
    update_fingerprint(&mut hasher, &evidence.project_id.to_be_bytes());
    update_fingerprint(&mut hasher, &evidence.binding_revision.to_be_bytes());
    update_fingerprint(&mut hasher, evidence.project_identity.as_bytes());
    update_executable_fingerprint(&mut hasher, evidence.executable_identity);
    update_fingerprint(&mut hasher, plan.profile().as_bytes());
    for argument in plan.args() {
        update_fingerprint(&mut hasher, argument.as_bytes());
    }
    for (role, selector) in plan.model_roles() {
        update_fingerprint(&mut hasher, role.as_bytes());
        update_fingerprint(&mut hasher, selector.as_bytes());
    }
    if let Some(thinking_level) = plan.thinking_level() {
        update_fingerprint(&mut hasher, thinking_level.as_bytes());
    }
    if let Some(session) = evidence.session {
        update_fingerprint(&mut hasher, &session.preview.session_index_id.to_be_bytes());
        update_fingerprint(&mut hasher, session.preview.session_id.as_bytes());
        update_fingerprint(
            &mut hasher,
            session.session_path.as_os_str().as_encoded_bytes(),
        );
        update_fingerprint(&mut hasher, session.source_identity_json.as_bytes());
        update_fingerprint(
            &mut hasher,
            &session.preview.source_size_bytes.to_be_bytes(),
        );
        update_fingerprint(
            &mut hasher,
            &session.preview.source_modified_at_epoch_ms.to_be_bytes(),
        );
    }
    for environment in evidence.environment {
        update_fingerprint(&mut hasher, environment.name.as_bytes());
        match environment.source {
            EnvironmentSource::ManagerProcess => {
                update_fingerprint(&mut hasher, b"manager_process")
            }
        }
        match &environment.value_fingerprint {
            Some(fingerprint) => update_fingerprint(&mut hasher, fingerprint.as_bytes()),
            None => update_fingerprint(&mut hasher, b"absent"),
        }
    }
    finalize_fingerprint(hasher)
}

fn capture_environment_evidence(salt: &[u8], names: &[String]) -> Vec<EnvironmentEvidence> {
    names
        .iter()
        .map(|name| {
            let value_fingerprint = std::env::var_os(name).map(|value| {
                let mut hasher = Sha256::new();
                update_fingerprint(&mut hasher, salt);
                update_fingerprint(&mut hasher, b"launch_environment_value_v1");
                update_fingerprint(&mut hasher, name.as_bytes());
                update_fingerprint(&mut hasher, value.as_os_str().as_encoded_bytes());
                finalize_fingerprint(hasher)
            });
            EnvironmentEvidence {
                name: name.clone(),
                source: EnvironmentSource::ManagerProcess,
                value_fingerprint,
            }
        })
        .collect()
}

fn finalize_fingerprint(hasher: Sha256) -> String {
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn update_fingerprint(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn update_executable_fingerprint(hasher: &mut Sha256, identity: &ExecutableIdentityEvidence) {
    update_fingerprint(
        hasher,
        identity.canonical_path.as_os_str().as_encoded_bytes(),
    );
    update_fingerprint(hasher, &identity.size.to_be_bytes());
    update_fingerprint(hasher, &identity.sha256);
    if let Some(modified_at) = identity.modified_at_epoch_nanos {
        update_fingerprint(hasher, &modified_at.to_be_bytes());
    }
    #[cfg(unix)]
    {
        update_fingerprint(hasher, &identity.device.to_be_bytes());
        update_fingerprint(hasher, &identity.inode.to_be_bytes());
    }
    if let Some(interpreter) = &identity.interpreter {
        update_executable_fingerprint(hasher, interpreter);
    }
}

fn prune_plans(registry: &mut PlanRegistry) {
    let now = Instant::now();
    registry.plans.retain(|_, plan| {
        plan.state == StoredPlanState::Prepared && plan.expires_at_monotonic >= now
    });
}

fn validate_plan_id(plan_id: &str) -> Result<(), DomainError> {
    Uuid::parse_str(plan_id).map(|_| ()).map_err(|_| {
        launch_error(
            "launch_plan_id_invalid",
            "启动预览标识无效。",
            "重新生成启动预览。",
            false,
            "plan id was not a UUID",
        )
    })
}

fn launch_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    technical_detail: &str,
) -> DomainError {
    DomainError::new(
        code,
        message,
        suggestion,
        retryable,
        redact(technical_detail),
    )
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_environment_is_provider_scoped_and_profile_policy_uses_no_parent_key() {
        let roles = BTreeMap::from([("default".to_owned(), "openai/gpt-test".to_owned())]);
        let automatic = build_launch_environment_allowlist(
            &CredentialPolicy::Automatic,
            &roles,
            TerminalMode::Embedded,
        );
        assert!(automatic.iter().any(|name| name == "OPENAI_API_KEY"));
        assert!(!automatic.iter().any(|name| name == "ANTHROPIC_API_KEY"));
        assert!(!automatic.iter().any(|name| name.starts_with("PI_")));
        assert!(!automatic.iter().any(|name| name == "DISPLAY"));

        let profile = build_launch_environment_allowlist(
            &CredentialPolicy::Profile,
            &roles,
            TerminalMode::External,
        );
        assert!(!profile.iter().any(|name| name == "OPENAI_API_KEY"));
        assert!(profile.iter().any(|name| name == "DISPLAY"));
        assert!(profile
            .iter()
            .any(|name| name == "DBUS_SESSION_BUS_ADDRESS"));
    }
}
