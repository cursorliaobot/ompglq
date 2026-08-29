use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::adapters::omp::{parse_session_bytes, ParsedSession, SessionParseLimits};
use crate::adapters::targets::{AllowedJsonlListingRequest, AllowedReadRequest, ExecutionTarget};
use crate::domain::{
    is_valid_profile, Diagnostic, DomainError, ProfileSessionRootStatus, ProjectSessionPreview,
    ProjectSessionPreviewMessage, ProjectSessionPreviewRequest, ProjectSessionSummary,
    ProjectSessionsSnapshot, SessionFreshness, SessionReadStatus,
};
use crate::infrastructure::db::{Database, DatabaseRuntime};
use crate::infrastructure::secrets::sanitize_untrusted_text;

const TARGET_ID: &str = "local";
const PARSER_VERSION: i64 = 1;
const MAXIMUM_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;
const MAXIMUM_SESSION_ENTRIES: usize = 20_000;
const MAXIMUM_SESSION_DIRECTORIES: usize = 4_096;
const MAXIMUM_SESSION_FILES: usize = 2_000;
const MAXIMUM_SESSION_INDEX_RESULTS: usize = 2_000;
const MAXIMUM_SCAN_BYTES: usize = 128 * 1024 * 1024;
const MAXIMUM_DIAGNOSTICS: usize = 100;
const MAXIMUM_JSON_BYTES: usize = 65_536;
const MAXIMUM_PREVIEW_MESSAGES: usize = 200;
const MAXIMUM_PREVIEW_CHARACTERS: usize = 256 * 1024;
const MAXIMUM_MODEL_ROLES: usize = 64;

#[derive(Clone)]
pub struct SessionService {
    database: DatabaseRuntime,
    target: Arc<dyn ExecutionTarget>,
    active_profiles: Arc<Mutex<HashSet<String>>>,
}

pub struct SessionRootAuthorizationIntent {
    project_id: i64,
    profile: String,
    binding_revision: u64,
    guard: SessionProfileGuard,
}

impl std::fmt::Debug for SessionRootAuthorizationIntent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionRootAuthorizationIntent")
            .field("project_id", &self.project_id)
            .field("profile", &self.profile)
            .field("binding_revision", &self.binding_revision)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for SessionService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionService")
            .field("target_id", &self.target.target_id())
            .finish_non_exhaustive()
    }
}

impl SessionService {
    pub fn new(database: DatabaseRuntime, target: Arc<dyn ExecutionTarget>) -> Self {
        Self {
            database,
            target,
            active_profiles: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn ensure_available(&self) -> Result<(), DomainError> {
        ensure_supported_target(self.target.as_ref())
    }

    pub async fn snapshot(&self, project_id: i64) -> Result<ProjectSessionsSnapshot, DomainError> {
        validate_project_id(project_id)?;
        let database = self.database.clone();
        spawn_session_task("load_session_snapshot", move || {
            let database = database.database()?;
            load_project_sessions_snapshot(&database, project_id, Vec::new())
        })
        .await
    }

    pub async fn prepare_root_authorization(
        &self,
        project_id: i64,
    ) -> Result<SessionRootAuthorizationIntent, DomainError> {
        validate_project_id(project_id)?;
        ensure_supported_target(self.target.as_ref())?;
        let database = self.database.clone();
        let project = spawn_session_task("prepare_session_root", move || {
            let database = database.database()?;
            database.with_connection(|connection| load_session_project(connection, project_id))
        })
        .await?;
        let guard = self.acquire_profile(&project.profile)?;
        Ok(SessionRootAuthorizationIntent {
            project_id,
            profile: project.profile,
            binding_revision: project.binding_revision,
            guard,
        })
    }

    pub async fn authorize_and_scan(
        &self,
        project_id: i64,
        selected_root: PathBuf,
    ) -> Result<ProjectSessionsSnapshot, DomainError> {
        let intent = self.prepare_root_authorization(project_id).await?;
        self.authorize_and_scan_intent(intent, selected_root).await
    }

    pub async fn authorize_and_scan_intent(
        &self,
        intent: SessionRootAuthorizationIntent,
        selected_root: PathBuf,
    ) -> Result<ProjectSessionsSnapshot, DomainError> {
        let SessionRootAuthorizationIntent {
            project_id,
            profile,
            binding_revision,
            guard,
        } = intent;
        let authorized = self
            .target
            .authorize_session_directory(&selected_root)
            .await?;
        let canonical_path = path_to_text(&authorized.canonical_path)?;
        let canonical_key = canonical_path.clone();
        let display_path = path_to_text(&selected_root)?;
        if authorized.stable_identity_json.len() > MAXIMUM_JSON_BYTES {
            return Err(session_error(
                "session_root_identity_too_large",
                "会话根目录身份数据超过支持上限。",
                "请选择普通本地文件系统中的 OMP sessions 目录。",
                false,
                "stage=authorize_session_root; identity=too_large",
            ));
        }
        let database = self.database.clone();
        let scan_project = SessionProject {
            profile: profile.clone(),
            binding_revision,
        };
        let stable_identity_json = authorized.stable_identity_json;
        spawn_session_task("persist_session_root", move || {
            let database = database.database()?;
            persist_profile_session_root(
                &database,
                PersistSessionRoot {
                    project_id,
                    profile,
                    binding_revision,
                    canonical_path,
                    canonical_key,
                    display_path,
                    stable_identity_json,
                    now: epoch_millis_i64()?,
                },
            )
        })
        .await?;
        let result = self.scan_locked(project_id, scan_project).await;
        drop(guard);
        result
    }

    pub async fn scan(&self, project_id: i64) -> Result<ProjectSessionsSnapshot, DomainError> {
        validate_project_id(project_id)?;
        ensure_supported_target(self.target.as_ref())?;
        let project = {
            let database = self.database.clone();
            spawn_session_task("load_session_scan_profile", move || {
                let database = database.database()?;
                database.with_connection(|connection| load_session_project(connection, project_id))
            })
            .await?
        };
        let guard = self.acquire_profile(&project.profile)?;
        let result = self.scan_locked(project_id, project).await;
        drop(guard);
        result
    }

    pub async fn preview(
        &self,
        request: ProjectSessionPreviewRequest,
    ) -> Result<ProjectSessionPreview, DomainError> {
        validate_project_id(request.project_id)?;
        validate_session_index_id(request.session_index_id)?;
        ensure_supported_target(self.target.as_ref())?;
        let project_id = request.project_id;
        let project = {
            let database = self.database.clone();
            spawn_session_task("load_session_preview_profile", move || {
                let database = database.database()?;
                database.with_connection(|connection| load_session_project(connection, project_id))
            })
            .await?
        };
        let guard = self.acquire_profile(&project.profile)?;
        let result = self.preview_locked(request, project).await;
        drop(guard);
        result
    }

    async fn preview_locked(
        &self,
        request: ProjectSessionPreviewRequest,
        project: SessionProject,
    ) -> Result<ProjectSessionPreview, DomainError> {
        let project_id = request.project_id;
        let session_index_id = request.session_index_id;
        let context = {
            let database = self.database.clone();
            spawn_session_task("load_session_preview_context", move || {
                let database = database.database()?;
                database.with_connection(|connection| {
                    load_session_preview_context(connection, project_id, session_index_id)
                })
            })
            .await?
        };
        if context.profile != project.profile
            || context.binding_revision != project.binding_revision
        {
            return Err(session_error(
                "session_profile_binding_changed",
                "项目 Profile 在预览开始时发生变化。",
                "刷新项目会话列表后重试。",
                true,
                "stage=session_preview; binding=changed",
            ));
        }
        let root = context.root.ok_or_else(|| {
            session_error(
                "profile_session_root_not_configured",
                "当前 Profile 尚未授权会话根目录。",
                "通过系统目录选择器授权 OMP sessions 目录。",
                false,
                "stage=session_preview; root=unconfigured",
            )
        })?;
        if root.status == ProfileSessionRootStatus::Revoked {
            return Err(session_error(
                "profile_session_root_revoked",
                "绑定 Profile 的会话根授权已撤销。",
                "重新授权 OMP sessions 目录后再预览。",
                false,
                "stage=session_preview; root=revoked",
            ));
        }
        let current_root = match self
            .target
            .authorize_session_directory(Path::new(&root.canonical_path))
            .await
        {
            Ok(current) => current,
            Err(error) => {
                return Err(self
                    .persist_root_failure(&root, error, "session_preview")
                    .await?);
            }
        };
        if path_to_text(&current_root.canonical_path)? != root.canonical_path
            || !stable_identity_matches(
                &root.stable_identity_json,
                &current_root.stable_identity_json,
            )?
        {
            self.update_root_status(&root, ProfileSessionRootStatus::Replaced)
                .await?;
            return Err(session_error(
                "profile_session_root_replaced",
                "绑定 Profile 的会话根在授权后被替换。",
                "重新授权预期的 OMP sessions 目录。",
                false,
                "stage=session_preview; root=replaced",
            ));
        }
        self.update_root_status(&root, ProfileSessionRootStatus::Active)
            .await?;

        let session_path = PathBuf::from(&context.session_path);
        let relative_path = session_path
            .strip_prefix(&current_root.canonical_path)
            .map(Path::to_owned)
            .map_err(|_| {
                session_error(
                    "session_preview_path_outside_root",
                    "索引中的会话文件不属于当前 Profile 授权根。",
                    "重新扫描会话目录。",
                    false,
                    "stage=session_preview; path=outside_root",
                )
            })?;
        let parser_limits = SessionParseLimits::default();
        let read = match self
            .target
            .read_allowed_file(AllowedReadRequest {
                authorized_root: current_root.canonical_path.clone(),
                expected_root_identity_json: current_root.stable_identity_json.clone(),
                relative_path,
                maximum_bytes: parser_limits.maximum_file_bytes,
            })
            .await
        {
            Ok(read) => read,
            Err(error) if root_failure_status(&error).is_some() => {
                return Err(self
                    .persist_root_failure(&root, error, "session_preview_read")
                    .await?);
            }
            Err(error) => return Err(error),
        };
        if !stable_file_identity_matches(&context.source_identity_json, &read.source_identity_json)?
        {
            return Err(session_error(
                "session_preview_file_replaced",
                "会话文件身份与索引记录不一致。",
                "重新扫描会话目录后再预览。",
                true,
                "stage=session_preview; file_identity=changed",
            ));
        }
        let parsed = parse_session_bytes(&read.bytes, read.source_truncated, &parser_limits)?;
        if parsed.header.id != context.session_id {
            return Err(session_error(
                "session_preview_id_changed",
                "会话文件标识与索引记录不一致。",
                "重新扫描会话目录后再预览。",
                true,
                "stage=session_preview; session_id=changed",
            ));
        }
        let cwd = PathBuf::from(&parsed.header.cwd);
        if !cwd.is_absolute() {
            return Err(session_error(
                "session_preview_cwd_unavailable",
                "会话工作目录不是可确认的绝对路径。",
                "恢复原项目路径并重新扫描。",
                false,
                "stage=session_preview; cwd=relative",
            ));
        }
        let canonical_cwd = self.target.canonicalize_path(&cwd).await.map_err(|_| {
            session_error(
                "session_preview_cwd_unavailable",
                "会话工作目录当前离线或无法确认。",
                "恢复原项目路径并重新扫描。",
                true,
                "stage=session_preview; cwd=unavailable",
            )
        })?;
        let project_roots = {
            let database = self.database.clone();
            spawn_session_task("load_preview_project_roots", move || {
                let database = database.database()?;
                database.with_connection(load_project_roots)
            })
            .await?
        };
        let owner = project_roots
            .iter()
            .filter(|(_, candidate)| canonical_cwd.starts_with(candidate))
            .max_by_key(|(_, candidate)| candidate.components().count())
            .map(|(project_id, _)| *project_id);
        if owner != Some(request.project_id) {
            return Err(session_error(
                "session_preview_project_changed",
                "会话当前不再归属于所选项目。",
                "重新扫描相关项目后刷新列表。",
                true,
                "stage=session_preview; project_owner=changed",
            ));
        }

        let final_root = match self
            .target
            .authorize_session_directory(Path::new(&root.canonical_path))
            .await
        {
            Ok(current) => current,
            Err(error) => {
                return Err(self
                    .persist_root_failure(&root, error, "session_preview_finalize")
                    .await?);
            }
        };
        if path_to_text(&final_root.canonical_path)? != root.canonical_path
            || !stable_identity_matches(
                &root.stable_identity_json,
                &final_root.stable_identity_json,
            )?
        {
            self.update_root_status(&root, ProfileSessionRootStatus::Replaced)
                .await?;
            return Err(session_error(
                "profile_session_root_replaced",
                "Profile 会话根在预览期间被替换。",
                "重新授权预期的 OMP sessions 目录。",
                false,
                "stage=session_preview_finalize; root=replaced",
            ));
        }

        let database = self.database.clone();
        let expected_scope = PreviewScopeCheck {
            project_id: request.project_id,
            session_index_id: request.session_index_id,
            profile: context.profile.clone(),
            binding_revision: context.binding_revision,
            root_mapping_id: root.mapping_id,
            authorized_root_id: root.root_id,
            session_path: context.session_path,
            session_id: context.session_id,
            source_identity_json: context.source_identity_json,
        };
        spawn_session_task("revalidate_session_preview_scope", move || {
            let database = database.database()?;
            verify_session_preview_scope(&database, expected_scope)
        })
        .await?;
        preview_from_parse(
            request.project_id,
            request.session_index_id,
            context.profile,
            read.source_size,
            read.modified_at_epoch_ms,
            parsed,
        )
    }

    async fn scan_locked(
        &self,
        project_id: i64,
        project: SessionProject,
    ) -> Result<ProjectSessionsSnapshot, DomainError> {
        let context = {
            let database = self.database.clone();
            spawn_session_task("load_session_scan_context", move || {
                let database = database.database()?;
                database
                    .with_connection(|connection| load_session_scan_context(connection, project_id))
            })
            .await?
        };
        if context.profile != project.profile
            || context.binding_revision != project.binding_revision
        {
            return Err(session_error(
                "session_profile_binding_changed",
                "项目 Profile 在扫描开始时发生变化。",
                "刷新项目后重新扫描。",
                true,
                "stage=session_scan; binding=changed",
            ));
        }
        let Some(root) = context.root.clone() else {
            return self.snapshot(project_id).await;
        };
        if root.status == ProfileSessionRootStatus::Revoked {
            return Err(session_error(
                "profile_session_root_revoked",
                "绑定 Profile 的会话根授权已撤销。",
                "通过系统目录选择器重新授权 OMP sessions 目录。",
                false,
                "stage=session_scan; root=revoked",
            ));
        }

        let current_root = match self
            .target
            .authorize_session_directory(Path::new(&root.canonical_path))
            .await
        {
            Ok(current) => current,
            Err(error) => {
                return Err(self
                    .persist_root_failure(&root, error, "session_scan")
                    .await?);
            }
        };
        let current_path = path_to_text(&current_root.canonical_path)?;
        if current_path != root.canonical_path
            || !stable_identity_matches(
                &root.stable_identity_json,
                &current_root.stable_identity_json,
            )?
        {
            self.update_root_status(&root, ProfileSessionRootStatus::Replaced)
                .await?;
            return Err(session_error(
                "profile_session_root_replaced",
                "绑定 Profile 的会话根在授权后指向了不同目录。",
                "重新选择并授权预期的 OMP sessions 目录。",
                false,
                "stage=session_scan; root=replaced",
            ));
        }
        self.update_root_status(&root, ProfileSessionRootStatus::Active)
            .await?;

        let listing = match self
            .target
            .list_allowed_jsonl_files(AllowedJsonlListingRequest {
                authorized_root: current_root.canonical_path.clone(),
                expected_root_identity_json: current_root.stable_identity_json.clone(),
                maximum_entries: MAXIMUM_SESSION_ENTRIES,
                maximum_directories: MAXIMUM_SESSION_DIRECTORIES,
                maximum_files: MAXIMUM_SESSION_FILES,
            })
            .await
        {
            Ok(listing) => listing,
            Err(error) if root_failure_status(&error).is_some() => {
                return Err(self
                    .persist_root_failure(&root, error, "session_listing")
                    .await?);
            }
            Err(error) => return Err(error),
        };
        let project_roots = {
            let database = self.database.clone();
            spawn_session_task("load_project_roots", move || {
                let database = database.database()?;
                database.with_connection(load_project_roots)
            })
            .await?
        };
        let parser_limits = SessionParseLimits::default();
        let mut diagnostics = Vec::new();
        if listing.skipped_entry_count > 0 {
            push_diagnostic(
                &mut diagnostics,
                Diagnostic::new(
                    "session_listing_entries_skipped",
                    "会话根中有无法安全列举的条目。",
                    "符号链接、不可读目录和特殊文件已跳过。",
                    true,
                    format!(
                        "stage=session_listing; skipped_entries={}",
                        listing.skipped_entry_count
                    ),
                ),
            );
        }
        let mut records = Vec::new();
        let mut failed_paths = Vec::new();
        let mut total_bytes = 0_usize;
        let mut scan_complete = listing.skipped_entry_count == 0;

        for (file_index, relative_file) in listing.files.into_iter().enumerate() {
            let session_path = current_root.canonical_path.join(&relative_file);
            let read = match self
                .target
                .read_allowed_file(AllowedReadRequest {
                    authorized_root: current_root.canonical_path.clone(),
                    expected_root_identity_json: current_root.stable_identity_json.clone(),
                    relative_path: relative_file,
                    maximum_bytes: parser_limits.maximum_file_bytes,
                })
                .await
            {
                Ok(read) => read,
                Err(error) => {
                    scan_complete = false;
                    failed_paths.push(session_path);
                    push_file_diagnostic(&mut diagnostics, file_index, error);
                    continue;
                }
            };
            total_bytes =
                total_bytes.saturating_add(usize::try_from(read.source_size).unwrap_or(usize::MAX));
            if total_bytes > MAXIMUM_SCAN_BYTES {
                return Err(session_error(
                    "session_scan_byte_limit_exceeded",
                    "本次会话扫描超过总字节上限。",
                    "缩小授权范围或分批扫描后重试。",
                    false,
                    "stage=session_scan; total_bytes=too_large",
                ));
            }
            let parsed =
                match parse_session_bytes(&read.bytes, read.source_truncated, &parser_limits) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        scan_complete = false;
                        failed_paths.push(session_path);
                        push_file_diagnostic(&mut diagnostics, file_index, error);
                        continue;
                    }
                };
            let cwd = PathBuf::from(&parsed.header.cwd);
            if !cwd.is_absolute() {
                scan_complete = false;
                failed_paths.push(session_path);
                push_diagnostic(
                    &mut diagnostics,
                    Diagnostic::new(
                        "session_cwd_not_absolute",
                        "会话头记录了非绝对工作目录，已跳过。",
                        "保留原会话并使用 OMP 检查其来源。",
                        false,
                        format!("stage=session_scan; file_index={file_index}"),
                    ),
                );
                continue;
            }
            let canonical_cwd = match self.target.canonicalize_path(&cwd).await {
                Ok(path) => path,
                Err(_) => {
                    scan_complete = false;
                    failed_paths.push(session_path);
                    push_diagnostic(
                        &mut diagnostics,
                        Diagnostic::new(
                            "session_cwd_unavailable",
                            "会话工作目录当前离线或无法确认，已跳过索引。",
                            "恢复原项目路径后重新扫描。",
                            true,
                            format!("stage=session_scan; file_index={file_index}"),
                        ),
                    );
                    continue;
                }
            };
            let owner = project_roots
                .iter()
                .filter(|(_, root)| canonical_cwd.starts_with(root))
                .max_by_key(|(_, root)| root.components().count())
                .map(|(project_id, _)| *project_id);
            if owner != Some(project_id) {
                continue;
            }
            match index_record_from_parse(
                &session_path,
                &read.source_identity_json,
                read.source_size,
                read.modified_at_epoch_ms,
                parsed,
                epoch_millis_i64()?,
            ) {
                Ok(record) => records.push(record),
                Err(error) => {
                    scan_complete = false;
                    failed_paths.push(session_path);
                    push_file_diagnostic(&mut diagnostics, file_index, error);
                }
            }
        }

        let final_root = match self
            .target
            .authorize_session_directory(Path::new(&root.canonical_path))
            .await
        {
            Ok(current) => current,
            Err(error) => {
                return Err(self
                    .persist_root_failure(&root, error, "session_scan_finalize")
                    .await?);
            }
        };
        if path_to_text(&final_root.canonical_path)? != root.canonical_path
            || !stable_identity_matches(
                &root.stable_identity_json,
                &final_root.stable_identity_json,
            )?
        {
            self.update_root_status(&root, ProfileSessionRootStatus::Replaced)
                .await?;
            return Err(session_error(
                "profile_session_root_replaced",
                "Profile 会话根在扫描期间被替换。",
                "重新授权预期的 OMP sessions 目录。",
                false,
                "stage=session_scan_finalize; root=replaced",
            ));
        }

        let database = self.database.clone();
        let profile = context.profile.clone();
        let root_id = root.mapping_id;
        let scanned_at = epoch_millis_i64()?;
        spawn_session_task("persist_session_index", move || {
            let database = database.database()?;
            persist_session_index(
                &database,
                PersistSessionScan {
                    project_id,
                    profile,
                    root_mapping_id: root_id,
                    authorized_root_id: root.root_id,
                    binding_revision: context.binding_revision,
                    scanned_at,
                    scan_complete,
                    records,
                    failed_paths,
                },
            )
        })
        .await?;
        let database = self.database.clone();
        spawn_session_task("load_scanned_sessions", move || {
            let database = database.database()?;
            load_project_sessions_snapshot(&database, project_id, diagnostics)
        })
        .await
    }

    fn acquire_profile(&self, profile: &str) -> Result<SessionProfileGuard, DomainError> {
        let mut active = self.active_profiles.lock().map_err(|_| {
            session_error(
                "session_scan_registry_poisoned",
                "会话操作状态不可用。",
                "重新启动应用后重试。",
                false,
                "stage=session_operation; registry=poisoned",
            )
        })?;
        if !active.insert(profile.to_owned()) {
            return Err(session_error(
                "session_scan_in_progress",
                "该 Profile 已有会话操作正在进行。",
                "等待当前操作完成。",
                true,
                "stage=session_operation; duplicate=active",
            ));
        }
        Ok(SessionProfileGuard {
            profile: profile.to_owned(),
            active_profiles: Arc::clone(&self.active_profiles),
        })
    }

    async fn update_root_status(
        &self,
        root: &ProfileRootRecord,
        status: ProfileSessionRootStatus,
    ) -> Result<(), DomainError> {
        let database = self.database.clone();
        let root = root.clone();
        spawn_session_task("update_profile_root_status", move || {
            let database = database.database()?;
            update_profile_root_status(&database, &root, status)
        })
        .await
    }

    async fn persist_root_failure(
        &self,
        root: &ProfileRootRecord,
        error: DomainError,
        stage: &str,
    ) -> Result<DomainError, DomainError> {
        let status = root_failure_status(&error).unwrap_or(ProfileSessionRootStatus::Offline);
        self.update_root_status(root, status).await?;
        Ok(match status {
            ProfileSessionRootStatus::Replaced => session_error(
                "profile_session_root_replaced",
                "绑定 Profile 的会话根在授权后被替换。",
                "重新选择并授权预期的 OMP sessions 目录。",
                false,
                &format!("stage={stage}; root=replaced; cause={}", error.code),
            ),
            _ => session_error(
                "profile_session_root_offline",
                "绑定 Profile 的会话根当前不可访问。",
                "恢复目录或权限后重新扫描。",
                true,
                &format!("stage={stage}; root=offline; cause={}", error.code),
            ),
        })
    }
}

struct SessionProfileGuard {
    profile: String,
    active_profiles: Arc<Mutex<HashSet<String>>>,
}

impl Drop for SessionProfileGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_profiles.lock() {
            active.remove(&self.profile);
        }
    }
}

struct SessionProject {
    profile: String,
    binding_revision: u64,
}

#[derive(Clone)]
struct ProfileRootRecord {
    mapping_id: i64,
    root_id: i64,
    canonical_path: String,
    canonical_key: String,
    stable_identity_json: String,
    status: ProfileSessionRootStatus,
    last_scanned_at_epoch_ms: Option<i64>,
}

struct SessionScanContext {
    profile: String,
    binding_revision: u64,
    root: Option<ProfileRootRecord>,
}

struct SessionPreviewContext {
    profile: String,
    binding_revision: u64,
    root: Option<ProfileRootRecord>,
    session_path: String,
    session_id: String,
    source_identity_json: String,
}

struct PreviewScopeCheck {
    project_id: i64,
    session_index_id: i64,
    profile: String,
    binding_revision: u64,
    root_mapping_id: i64,
    authorized_root_id: i64,
    session_path: String,
    session_id: String,
    source_identity_json: String,
}

struct PersistSessionRoot {
    project_id: i64,
    profile: String,
    binding_revision: u64,
    canonical_path: String,
    canonical_key: String,
    display_path: String,
    stable_identity_json: String,
    now: i64,
}

struct SessionIndexRecord {
    session_path: String,
    session_id: String,
    cwd: String,
    title: String,
    modified_at_epoch_ms: i64,
    read_status: &'static str,
    model_selector: Option<String>,
    provider: Option<String>,
    credential_providers_json: String,
    message_count: i64,
    size_bytes: i64,
    fingerprint: String,
    source_identity_json: String,
    scan_offset: i64,
    warning_codes_json: String,
    scanned_at_epoch_ms: i64,
}

struct PersistSessionScan {
    project_id: i64,
    profile: String,
    root_mapping_id: i64,
    authorized_root_id: i64,
    binding_revision: u64,
    scanned_at: i64,
    scan_complete: bool,
    records: Vec<SessionIndexRecord>,
    failed_paths: Vec<PathBuf>,
}

fn load_session_project(
    connection: &rusqlite::Connection,
    project_id: i64,
) -> Result<SessionProject, DomainError> {
    let project = connection
        .query_row(
            "SELECT binding.profile, binding.revision
             FROM projects AS project
             JOIN project_bindings AS binding
               ON binding.target_id = project.target_id
              AND binding.project_id = project.id
             WHERE project.target_id = ?1 AND project.id = ?2",
            params![TARGET_ID, project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| session_database_error("load_session_project", &error))?
        .ok_or_else(|| project_not_found("load_session_project"))?;
    if !is_valid_profile(&project.0) {
        return Err(session_data_error("profile", "invalid"));
    }
    Ok(SessionProject {
        profile: project.0,
        binding_revision: nonnegative_u64("binding_revision", project.1)?,
    })
}

fn load_session_scan_context(
    connection: &rusqlite::Connection,
    project_id: i64,
) -> Result<SessionScanContext, DomainError> {
    let project = load_session_project(connection, project_id)?;
    let root = connection
        .query_row(
            "SELECT
                mapping.id,
                root.id,
                root.canonical_path,
                root.canonical_key,
                root.stable_identity_json,
                root.status,
                mapping.last_scanned_at_epoch_ms
             FROM profile_session_roots AS mapping
             JOIN authorized_roots AS root
               ON root.id = mapping.authorized_root_id
              AND root.target_id = mapping.target_id
              AND root.kind = 'profile'
             WHERE mapping.target_id = ?1 AND mapping.profile = ?2",
            params![TARGET_ID, project.profile],
            |row| {
                Ok(ProfileRootRecord {
                    mapping_id: row.get(0)?,
                    root_id: row.get(1)?,
                    canonical_path: row.get(2)?,
                    canonical_key: row.get(3)?,
                    stable_identity_json: row.get(4)?,
                    status: parse_root_status(row.get::<_, String>(5)?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    last_scanned_at_epoch_ms: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| session_database_error("load_profile_session_root", &error))?;
    Ok(SessionScanContext {
        profile: project.profile,
        binding_revision: project.binding_revision,
        root,
    })
}

fn load_session_preview_context(
    connection: &rusqlite::Connection,
    project_id: i64,
    session_index_id: i64,
) -> Result<SessionPreviewContext, DomainError> {
    let context = load_session_scan_context(connection, project_id)?;
    let record = connection
        .query_row(
            "SELECT session_path, session_id, source_identity_json
             FROM session_index
             WHERE id = ?1
               AND target_id = ?2
               AND project_id = ?3
               AND profile = ?4",
            params![session_index_id, TARGET_ID, project_id, context.profile],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| session_database_error("load_session_preview_record", &error))?
        .ok_or_else(|| {
            session_error(
                "session_preview_not_found",
                "找不到当前项目和 Profile 下的会话索引。",
                "刷新会话列表后重试。",
                false,
                "stage=session_preview; record=missing",
            )
        })?;
    validate_index_text(&record.0, "session_path", 32_768, true)?;
    validate_index_text(&record.1, "session_id", 256, false)?;
    if record.2.len() > MAXIMUM_JSON_BYTES {
        return Err(session_data_error("source_identity_json", "too_large"));
    }
    Ok(SessionPreviewContext {
        profile: context.profile,
        binding_revision: context.binding_revision,
        root: context.root,
        session_path: record.0,
        session_id: record.1,
        source_identity_json: record.2,
    })
}

fn persist_profile_session_root(
    database: &Database,
    input: PersistSessionRoot,
) -> Result<(), DomainError> {
    let grant_metadata = serde_json::to_string(&serde_json::json!({
        "source": "native_picker",
        "profile": &input.profile,
    }))
    .map_err(|_| session_data_error("grant_metadata", "encode_failed"))?;
    database.with_connection_mut(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| session_database_error("begin_profile_root", &error))?;
        let current_binding: (String, i64) = transaction
            .query_row(
                "SELECT binding.profile, binding.revision
                 FROM projects AS project
                 JOIN project_bindings AS binding
                   ON binding.target_id = project.target_id
                  AND binding.project_id = project.id
                 WHERE project.target_id = ?1 AND project.id = ?2",
                params![TARGET_ID, input.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| session_database_error("revalidate_project_profile", &error))?;
        if current_binding.0 != input.profile
            || u64::try_from(current_binding.1).ok() != Some(input.binding_revision)
        {
            return Err(session_error(
                "session_profile_binding_changed",
                "项目 Profile 在目录选择期间发生变化。",
                "刷新项目并重新选择会话目录。",
                true,
                "stage=authorize_session_root; profile=changed",
            ));
        }
        {
            let mut statement = transaction
                .prepare(
                    "SELECT mapping.profile, root.canonical_path
                     FROM profile_session_roots AS mapping
                     JOIN authorized_roots AS root
                       ON root.id = mapping.authorized_root_id
                      AND root.target_id = mapping.target_id
                      AND root.kind = 'profile'
                     WHERE mapping.target_id = ?1 AND mapping.profile <> ?2",
                )
                .map_err(|error| session_database_error("prepare_profile_root_overlap", &error))?;
            let rows = statement
                .query_map(params![TARGET_ID, input.profile], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| session_database_error("query_profile_root_overlap", &error))?;
            let selected = Path::new(&input.canonical_path);
            for (index, row) in rows.enumerate() {
                if index >= 512 {
                    return Err(session_data_error("profile_session_roots", "too_many"));
                }
                let (_, path) = row.map_err(|error| {
                    session_database_error("decode_profile_root_overlap", &error)
                })?;
                let existing = Path::new(&path);
                if selected.starts_with(existing) || existing.starts_with(selected) {
                    return Err(session_error(
                        "session_root_overlaps_profile",
                        "所选会话根与另一个 Profile 的授权范围重叠。",
                        "为每个 Profile 选择互不重叠的 OMP sessions 目录。",
                        false,
                        "stage=authorize_session_root; overlap=detected",
                    ));
                }
            }
        }
        transaction
            .execute(
                "INSERT INTO authorized_roots (
                    target_id, kind, canonical_path, canonical_key, display_path,
                    stable_identity_json, grant_metadata_json, status,
                    granted_at_epoch_ms, last_verified_at_epoch_ms
                 ) VALUES (?1, 'profile', ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)
                 ON CONFLICT(target_id, kind, canonical_key) DO UPDATE SET
                    canonical_path = excluded.canonical_path,
                    display_path = excluded.display_path,
                    stable_identity_json = excluded.stable_identity_json,
                    grant_metadata_json = excluded.grant_metadata_json,
                    status = 'active',
                    granted_at_epoch_ms = excluded.granted_at_epoch_ms,
                    last_verified_at_epoch_ms = excluded.last_verified_at_epoch_ms",
                params![
                    TARGET_ID,
                    input.canonical_path,
                    input.canonical_key,
                    input.display_path,
                    input.stable_identity_json,
                    grant_metadata,
                    input.now,
                ],
            )
            .map_err(|error| session_database_error("upsert_profile_root", &error))?;
        let root_id: i64 = transaction
            .query_row(
                "SELECT id FROM authorized_roots
                 WHERE target_id = ?1 AND kind = 'profile' AND canonical_key = ?2",
                params![TARGET_ID, input.canonical_key],
                |row| row.get(0),
            )
            .map_err(|error| session_database_error("resolve_profile_root", &error))?;
        let used_by_other_profile: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM profile_session_roots
                    WHERE authorized_root_id = ?1 AND profile <> ?2
                 )",
                params![root_id, input.profile],
                |row| row.get(0),
            )
            .map_err(|error| session_database_error("check_profile_root_scope", &error))?;
        if used_by_other_profile {
            return Err(session_error(
                "session_root_already_bound",
                "该会话根已经绑定到另一个 Profile。",
                "为不同 Profile 选择各自独立的 OMP sessions 目录。",
                false,
                "stage=authorize_session_root; root=already_bound",
            ));
        }
        let previous_root_id: Option<i64> = transaction
            .query_row(
                "SELECT authorized_root_id FROM profile_session_roots
                 WHERE target_id = ?1 AND profile = ?2",
                params![TARGET_ID, input.profile],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| session_database_error("load_previous_profile_root", &error))?;
        transaction
            .execute(
                "INSERT INTO profile_session_roots (
                    target_id, profile, authorized_root_id,
                    created_at_epoch_ms, updated_at_epoch_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(target_id, profile) DO UPDATE SET
                    authorized_root_id = excluded.authorized_root_id,
                    updated_at_epoch_ms = excluded.updated_at_epoch_ms,
                    last_scanned_at_epoch_ms = NULL",
                params![TARGET_ID, input.profile, root_id, input.now],
            )
            .map_err(|error| session_database_error("upsert_profile_root_mapping", &error))?;
        transaction
            .execute(
                "UPDATE session_index
                 SET freshness = 'stale'
                 WHERE target_id = ?1 AND profile = ?2",
                params![TARGET_ID, input.profile],
            )
            .map_err(|error| session_database_error("stale_previous_session_index", &error))?;
        if let Some(previous_root_id) = previous_root_id.filter(|value| *value != root_id) {
            transaction
                .execute(
                    "DELETE FROM authorized_roots
                     WHERE id = ?1 AND kind = 'profile'
                       AND NOT EXISTS (
                           SELECT 1 FROM profile_session_roots
                           WHERE authorized_root_id = ?1
                       )",
                    [previous_root_id],
                )
                .map_err(|error| session_database_error("remove_previous_profile_root", &error))?;
        }
        transaction
            .commit()
            .map_err(|error| session_database_error("commit_profile_root", &error))
    })
}

fn load_project_roots(
    connection: &rusqlite::Connection,
) -> Result<Vec<(i64, PathBuf)>, DomainError> {
    let mut statement = connection
        .prepare(
            "SELECT id, canonical_path FROM projects
             WHERE target_id = ?1 ORDER BY id",
        )
        .map_err(|error| session_database_error("prepare_project_roots", &error))?;
    let rows = statement
        .query_map([TARGET_ID], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| session_database_error("query_project_roots", &error))?;
    let mut roots = Vec::new();
    for row in rows {
        let (id, path) =
            row.map_err(|error| session_database_error("decode_project_root", &error))?;
        validate_project_id(id)?;
        roots.push((id, PathBuf::from(path)));
        if roots.len() > MAXIMUM_SESSION_INDEX_RESULTS {
            return Err(session_data_error("project_roots", "too_many"));
        }
    }
    Ok(roots)
}

fn index_record_from_parse(
    file: &Path,
    source_identity_json: &str,
    source_size: u64,
    modified_at_epoch_ms: u64,
    parsed: ParsedSession,
    scanned_at_epoch_ms: i64,
) -> Result<SessionIndexRecord, DomainError> {
    let session_path = path_to_text(file)?;
    validate_index_text(&session_path, "session_path", 32_768, true)?;
    validate_index_text(&parsed.header.id, "session_id", 256, false)?;
    validate_index_text(&parsed.header.cwd, "cwd", 32_768, true)?;
    if let Some(title) = parsed.title.as_deref() {
        validate_index_text(title, "title", 2_048, true)?;
    }
    if let Some(model) = parsed.model_selector.as_deref() {
        validate_index_text(model, "model_selector", 512, false)?;
    }
    if let Some(provider) = parsed.provider.as_deref() {
        validate_index_text(provider, "provider", 256, false)?;
    }
    if parsed.credential_providers.len() > 512
        || parsed.credential_providers.iter().any(|provider| {
            validate_index_text(provider, "credential_provider", 256, false).is_err()
        })
    {
        return Err(session_data_error("credential_providers", "invalid"));
    }
    if parsed.warning_codes.len() > 512
        || parsed
            .warning_codes
            .iter()
            .any(|warning| validate_index_text(warning, "warning_code", 160, false).is_err())
    {
        return Err(session_data_error("warning_codes", "invalid"));
    }
    if source_identity_json.len() > MAXIMUM_JSON_BYTES {
        return Err(session_data_error("source_identity_json", "too_large"));
    }
    let credential_providers_json = serde_json::to_string(&parsed.credential_providers)
        .map_err(|_| session_data_error("credential_providers", "encode_failed"))?;
    let warning_codes_json = serde_json::to_string(&parsed.warning_codes)
        .map_err(|_| session_data_error("warning_codes", "encode_failed"))?;
    if credential_providers_json.len() > MAXIMUM_JSON_BYTES
        || warning_codes_json.len() > MAXIMUM_JSON_BYTES
    {
        return Err(session_data_error("session_metadata_json", "too_large"));
    }
    Ok(SessionIndexRecord {
        session_path,
        session_id: parsed.header.id,
        cwd: parsed.header.cwd,
        title: parsed.title.unwrap_or_default(),
        modified_at_epoch_ms: u64_to_i64("modified_at", modified_at_epoch_ms)?,
        read_status: read_status_text(parsed.read_status),
        model_selector: parsed.model_selector,
        provider: parsed.provider,
        credential_providers_json,
        message_count: u64_to_i64("message_count", parsed.message_count)?,
        size_bytes: u64_to_i64("size_bytes", source_size)?,
        fingerprint: source_identity_json.to_owned(),
        source_identity_json: source_identity_json.to_owned(),
        scan_offset: u64_to_i64("scan_offset", parsed.consumed_bytes)?,
        warning_codes_json,
        scanned_at_epoch_ms,
    })
}

fn persist_session_index(
    database: &Database,
    input: PersistSessionScan,
) -> Result<(), DomainError> {
    database.with_connection_mut(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| session_database_error("begin_session_index", &error))?;
        let scope_unchanged: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM projects AS project
                    JOIN project_bindings AS binding
                      ON binding.target_id = project.target_id
                     AND binding.project_id = project.id
                    JOIN profile_session_roots AS root
                      ON root.target_id = project.target_id
                     AND root.profile = binding.profile
                    WHERE project.target_id = ?1
                      AND project.id = ?2
                      AND binding.profile = ?3
                      AND binding.revision = ?4
                      AND root.id = ?5
                      AND root.authorized_root_id = ?6
                )",
                params![
                    TARGET_ID,
                    input.project_id,
                    input.profile,
                    u64_to_i64("binding_revision", input.binding_revision)?,
                    input.root_mapping_id,
                    input.authorized_root_id,
                ],
                |row| row.get(0),
            )
            .map_err(|error| session_database_error("revalidate_session_scan_scope", &error))?;
        if !scope_unchanged {
            return Err(session_error(
                "session_scan_scope_changed",
                "项目 Profile 或会话根在扫描期间发生变化。",
                "刷新项目会话状态后重新扫描。",
                true,
                "stage=session_index; scope=changed",
            ));
        }
        transaction
            .execute(
                "UPDATE session_index
                 SET freshness = ?1, last_scanned_at_epoch_ms = ?2
                 WHERE target_id = ?3 AND project_id = ?4 AND profile = ?5",
                params![
                    if input.scan_complete {
                        "missing"
                    } else {
                        "stale"
                    },
                    input.scanned_at,
                    TARGET_ID,
                    input.project_id,
                    input.profile,
                ],
            )
            .map_err(|error| session_database_error("age_session_index", &error))?;
        for failed_path in input.failed_paths {
            if let Some(path) = failed_path.to_str() {
                transaction
                    .execute(
                        "UPDATE session_index
                         SET freshness = 'failed', last_scanned_at_epoch_ms = ?1
                         WHERE target_id = ?2 AND profile = ?3 AND session_path = ?4",
                        params![input.scanned_at, TARGET_ID, input.profile, path],
                    )
                    .map_err(|error| session_database_error("mark_session_failed", &error))?;
            }
        }
        for record in input.records {
            let upserted = transaction
                .execute(
                    "INSERT INTO session_index (
                        target_id, project_id, profile, session_path, session_id, cwd,
                        title, first_message_summary, created_at_epoch_ms,
                        modified_at_epoch_ms, status, model_selector, provider,
                        masked_credential_label, message_count, size_bytes, fingerprint,
                        read_status, freshness, source_identity_json, scan_offset,
                        parser_version, last_scanned_at_epoch_ms, warning_codes_json,
                        credential_providers_json
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL,
                        ?8, 'unknown', ?9, ?10, NULL, ?11, ?12, ?13,
                        ?14, 'fresh', ?15, ?16, ?17, ?18, ?19, ?20
                     )
                     ON CONFLICT(target_id, profile, session_path) DO UPDATE SET
                        project_id = excluded.project_id,
                        profile = excluded.profile,
                        session_id = excluded.session_id,
                        cwd = excluded.cwd,
                        title = excluded.title,
                        first_message_summary = NULL,
                        created_at_epoch_ms = NULL,
                        modified_at_epoch_ms = excluded.modified_at_epoch_ms,
                        status = excluded.status,
                        model_selector = excluded.model_selector,
                        provider = excluded.provider,
                        masked_credential_label = NULL,
                        message_count = excluded.message_count,
                        size_bytes = excluded.size_bytes,
                        fingerprint = excluded.fingerprint,
                        read_status = excluded.read_status,
                        freshness = excluded.freshness,
                        source_identity_json = excluded.source_identity_json,
                        scan_offset = excluded.scan_offset,
                        parser_version = excluded.parser_version,
                        last_scanned_at_epoch_ms = excluded.last_scanned_at_epoch_ms,
                        warning_codes_json = excluded.warning_codes_json,
                        credential_providers_json = excluded.credential_providers_json",
                    params![
                        TARGET_ID,
                        input.project_id,
                        input.profile,
                        record.session_path,
                        record.session_id,
                        record.cwd,
                        record.title,
                        record.modified_at_epoch_ms,
                        record.model_selector,
                        record.provider,
                        record.message_count,
                        record.size_bytes,
                        record.fingerprint,
                        record.read_status,
                        record.source_identity_json,
                        record.scan_offset,
                        PARSER_VERSION,
                        record.scanned_at_epoch_ms,
                        record.warning_codes_json,
                        record.credential_providers_json,
                    ],
                )
                .map_err(|error| session_database_error("upsert_session_index", &error))?;
            if upserted != 1 {
                return Err(session_error(
                    "session_index_write_conflict",
                    "会话索引在写入期间发生冲突。",
                    "刷新会话列表后重新扫描。",
                    true,
                    "stage=session_index; upsert=conflict",
                ));
            }
        }
        let root_updated = transaction
            .execute(
                "UPDATE profile_session_roots
                 SET last_scanned_at_epoch_ms = ?1, updated_at_epoch_ms = ?1
                 WHERE id = ?2 AND target_id = ?3 AND profile = ?4",
                params![
                    input.scanned_at,
                    input.root_mapping_id,
                    TARGET_ID,
                    input.profile
                ],
            )
            .map_err(|error| session_database_error("update_profile_scan_time", &error))?;
        if root_updated != 1 {
            return Err(session_error(
                "profile_session_root_conflict",
                "Profile 会话根在扫描期间发生变化。",
                "刷新项目会话状态后重试。",
                true,
                "stage=session_index; root_mapping=changed",
            ));
        }
        transaction
            .commit()
            .map_err(|error| session_database_error("commit_session_index", &error))
    })
}

fn load_project_sessions_snapshot(
    database: &Database,
    project_id: i64,
    diagnostics: Vec<Diagnostic>,
) -> Result<ProjectSessionsSnapshot, DomainError> {
    database.with_connection(|connection| {
        let context = load_session_scan_context(connection, project_id)?;
        let last_scanned_at_epoch_ms = context
            .root
            .as_ref()
            .and_then(|root| root.last_scanned_at_epoch_ms)
            .map(|value| nonnegative_u64("last_scanned_at", value))
            .transpose()?;
        let mut statement = connection
            .prepare(
                "SELECT
                    id, session_id, project_id, profile, title, cwd,
                    created_at_epoch_ms, modified_at_epoch_ms, read_status, freshness,
                    model_selector, provider, credential_providers_json,
                    message_count, size_bytes, warning_codes_json
                 FROM session_index
                 WHERE target_id = ?1 AND project_id = ?2 AND profile = ?3
                 ORDER BY modified_at_epoch_ms DESC, id ASC
                 LIMIT ?4",
            )
            .map_err(|error| session_database_error("prepare_session_snapshot", &error))?;
        let rows = statement
            .query_map(
                params![
                    TARGET_ID,
                    project_id,
                    context.profile,
                    MAXIMUM_SESSION_INDEX_RESULTS as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, i64>(13)?,
                        row.get::<_, i64>(14)?,
                        row.get::<_, String>(15)?,
                    ))
                },
            )
            .map_err(|error| session_database_error("query_session_snapshot", &error))?;
        let mut sessions = Vec::new();
        for row in rows {
            let row =
                row.map_err(|error| session_database_error("decode_session_snapshot", &error))?;
            validate_project_id(row.0)?;
            validate_project_id(row.2)?;
            let credential_providers = parse_bounded_string_array(&row.12, "credential_providers")?;
            let warning_codes = parse_bounded_string_array(&row.15, "warning_codes")?;
            sessions.push(ProjectSessionSummary {
                session_index_id: row.0,
                session_id: bounded_text(row.1, "session_id", 256)?,
                project_id: row.2,
                profile: bounded_text(row.3, "profile", 64)?,
                title: sanitize_untrusted_text(&bounded_text(row.4, "title", 2_048)?),
                cwd_display: sanitize_untrusted_text(&bounded_text(row.5, "cwd", 32_768)?),
                created_at_epoch_ms: row
                    .6
                    .map(|value| nonnegative_u64("created_at", value))
                    .transpose()?,
                modified_at_epoch_ms: nonnegative_u64("modified_at", row.7)?,
                read_status: parse_read_status(&row.8)?,
                freshness: parse_freshness(&row.9)?,
                model_selector: row
                    .10
                    .map(|value| bounded_text(value, "model_selector", 512))
                    .transpose()?,
                provider: row
                    .11
                    .map(|value| bounded_text(value, "provider", 256))
                    .transpose()?,
                credential_providers,
                message_count: nonnegative_u64("message_count", row.13)?,
                size_bytes: nonnegative_u64("size_bytes", row.14)?,
                warning_codes,
            });
        }
        Ok(ProjectSessionsSnapshot {
            project_id,
            profile: context.profile,
            profile_inventory_complete: false,
            root_status: context
                .root
                .as_ref()
                .map_or(ProfileSessionRootStatus::Unconfigured, |root| root.status),
            last_scanned_at_epoch_ms,
            sessions,
            diagnostics,
        })
    })
}

fn update_profile_root_status(
    database: &Database,
    root: &ProfileRootRecord,
    status: ProfileSessionRootStatus,
) -> Result<(), DomainError> {
    let status = root_status_text(status)?;
    let changed = database.with_connection(|connection| {
        connection
            .execute(
                "UPDATE authorized_roots
                 SET status = ?1, last_verified_at_epoch_ms = ?2
                 WHERE id = ?3 AND target_id = ?4 AND kind = 'profile'
                   AND canonical_key = ?5 AND stable_identity_json = ?6",
                params![
                    status,
                    epoch_millis_i64()?,
                    root.root_id,
                    TARGET_ID,
                    root.canonical_key,
                    root.stable_identity_json,
                ],
            )
            .map_err(|error| session_database_error("update_profile_root_status", &error))
    })?;
    if changed != 1 {
        return Err(session_error(
            "profile_session_root_conflict",
            "Profile 会话根授权在验证期间发生变化。",
            "刷新项目会话状态后重试。",
            true,
            "stage=session_root_status; update=conflict",
        ));
    }
    Ok(())
}

fn verify_session_preview_scope(
    database: &Database,
    input: PreviewScopeCheck,
) -> Result<(), DomainError> {
    let unchanged = database.with_connection(|connection| {
        connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM projects AS project
                    JOIN project_bindings AS binding
                      ON binding.target_id = project.target_id
                     AND binding.project_id = project.id
                    JOIN profile_session_roots AS mapping
                      ON mapping.target_id = project.target_id
                     AND mapping.profile = binding.profile
                    JOIN authorized_roots AS root
                      ON root.id = mapping.authorized_root_id
                     AND root.target_id = mapping.target_id
                     AND root.kind = 'profile'
                    JOIN session_index AS session
                      ON session.target_id = project.target_id
                     AND session.project_id = project.id
                     AND session.profile = binding.profile
                    WHERE project.target_id = ?1
                      AND project.id = ?2
                      AND binding.profile = ?3
                      AND binding.revision = ?4
                      AND mapping.id = ?5
                      AND root.id = ?6
                      AND session.id = ?7
                      AND session.session_path = ?8
                      AND session.session_id = ?9
                      AND session.source_identity_json = ?10
                )",
                params![
                    TARGET_ID,
                    input.project_id,
                    input.profile,
                    u64_to_i64("binding_revision", input.binding_revision)?,
                    input.root_mapping_id,
                    input.authorized_root_id,
                    input.session_index_id,
                    input.session_path,
                    input.session_id,
                    input.source_identity_json,
                ],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| session_database_error("verify_session_preview_scope", &error))
    })?;
    if !unchanged {
        return Err(session_error(
            "session_preview_scope_changed",
            "项目、Profile、会话根或索引在预览期间发生变化。",
            "刷新会话列表后重试。",
            true,
            "stage=session_preview_finalize; scope=changed",
        ));
    }
    Ok(())
}

fn preview_from_parse(
    project_id: i64,
    session_index_id: i64,
    profile: String,
    source_size: u64,
    source_modified_at_epoch_ms: u64,
    parsed: ParsedSession,
) -> Result<ProjectSessionPreview, DomainError> {
    validate_preview_text(&profile, "profile", 64, false)?;
    validate_preview_text(&parsed.header.id, "session_id", 256, false)?;
    validate_preview_text(&parsed.header.cwd_display, "cwd_display", 32_768, false)?;
    if let Some(title) = parsed.title.as_deref() {
        validate_preview_text(title, "title", 2_048, true)?;
    }
    if let Some(model) = parsed.model_selector.as_deref() {
        validate_preview_text(model, "model_selector", 512, false)?;
    }
    if let Some(provider) = parsed.provider.as_deref() {
        validate_preview_text(provider, "provider", 256, false)?;
    }
    if let Some(role) = parsed.last_model_role.as_deref() {
        validate_preview_text(role, "last_model_role", 64, false)?;
    }
    if let Some(thinking) = parsed.thinking_level.as_deref() {
        validate_preview_text(thinking, "thinking_level", 64, false)?;
    }
    if let Some(summary) = parsed.first_message.as_deref() {
        validate_preview_text(summary, "first_message_summary", 512, true)?;
    }
    if parsed.model_roles.len() > MAXIMUM_MODEL_ROLES {
        return Err(session_error(
            "session_preview_metadata_too_large",
            "会话模型角色元数据超过预览上限。",
            "保留原文件并使用 OMP 检查其内容。",
            false,
            "stage=session_preview; model_roles=too_many",
        ));
    }
    for (role, model) in &parsed.model_roles {
        validate_preview_text(role, "model_role", 64, false)?;
        validate_preview_text(model, "role_model", 512, false)?;
    }
    if parsed.credential_providers.len() > 512
        || parsed.warning_codes.len() > 512
        || parsed.preview_messages.len() > MAXIMUM_PREVIEW_MESSAGES
    {
        return Err(session_error(
            "session_preview_metadata_too_large",
            "会话结构化元数据超过预览上限。",
            "保留原文件并使用 OMP 检查其内容。",
            false,
            "stage=session_preview; metadata=too_large",
        ));
    }
    for provider in &parsed.credential_providers {
        validate_preview_text(provider, "credential_provider", 256, false)?;
    }
    for warning in &parsed.warning_codes {
        validate_preview_text(warning, "warning_code", 160, false)?;
    }
    let mut total_characters = 0_usize;
    let mut messages = Vec::with_capacity(parsed.preview_messages.len());
    for message in parsed.preview_messages {
        validate_preview_text(&message.role, "message_role", 64, false)?;
        validate_preview_text(&message.text, "message_text", 16 * 1024, true)?;
        if let Some(timestamp) = message.timestamp.as_deref() {
            validate_preview_text(timestamp, "message_timestamp", 128, false)?;
        }
        total_characters = total_characters.saturating_add(message.text.chars().count());
        if total_characters > MAXIMUM_PREVIEW_CHARACTERS {
            return Err(session_error(
                "session_preview_content_too_large",
                "会话预览正文超过总字符上限。",
                "保留原文件并缩小预览范围。",
                false,
                "stage=session_preview; characters=too_many",
            ));
        }
        messages.push(ProjectSessionPreviewMessage {
            role: message.role,
            text: message.text,
            timestamp: message.timestamp,
        });
    }
    Ok(ProjectSessionPreview {
        project_id,
        session_index_id,
        profile,
        session_id: parsed.header.id,
        title: parsed.title.unwrap_or_default(),
        cwd_display: parsed.header.cwd_display,
        read_status: parsed.read_status,
        model_selector: parsed.model_selector,
        provider: parsed.provider,
        model_roles: parsed.model_roles,
        last_model_role: parsed.last_model_role,
        thinking_level: parsed.thinking_level,
        credential_providers: parsed.credential_providers,
        message_count: parsed.message_count,
        first_message_summary: parsed.first_message,
        messages,
        skipped_record_count: parsed.skipped_record_count,
        warning_codes: parsed.warning_codes,
        source_modified_at_epoch_ms,
        source_size_bytes: source_size,
    })
}

fn validate_preview_text(
    value: &str,
    field: &str,
    maximum_characters: usize,
    allow_empty: bool,
) -> Result<(), DomainError> {
    if !value.contains('\0')
        && value.chars().count() <= maximum_characters
        && (allow_empty || !value.trim().is_empty())
    {
        Ok(())
    } else {
        Err(session_error(
            "session_preview_metadata_invalid",
            "会话预览包含无法安全展示的结构化字段。",
            "保留原文件并重新扫描。",
            false,
            &format!("stage=session_preview; field={field}; value=invalid"),
        ))
    }
}

fn stable_identity_matches(expected: &str, current: &str) -> Result<bool, DomainError> {
    if expected.len() > MAXIMUM_JSON_BYTES || current.len() > MAXIMUM_JSON_BYTES {
        return Err(session_data_error("stable_identity", "too_large"));
    }
    let expected: serde_json::Value = serde_json::from_str(expected)
        .map_err(|_| session_data_error("stable_identity", "invalid_expected"))?;
    let current: serde_json::Value = serde_json::from_str(current)
        .map_err(|_| session_data_error("stable_identity", "invalid_current"))?;
    #[cfg(unix)]
    if expected.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_dev_ino_v1")
        || current.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_dev_ino_v1")
    {
        return Err(session_data_error("stable_identity", "unsupported_scheme"));
    }
    Ok(expected == current)
}

fn stable_file_identity_matches(expected: &str, current: &str) -> Result<bool, DomainError> {
    if expected.len() > MAXIMUM_JSON_BYTES || current.len() > MAXIMUM_JSON_BYTES {
        return Err(session_error(
            "session_preview_identity_unavailable",
            "会话文件身份记录超过支持上限。",
            "重新扫描会话目录后再预览。",
            false,
            "stage=session_preview; file_identity=too_large",
        ));
    }
    let parse_identity = |value: &str, source: &str| {
        let value: serde_json::Value = serde_json::from_str(value).map_err(|_| {
            session_error(
                "session_preview_identity_unavailable",
                "会话文件身份记录无法验证。",
                "重新扫描会话目录后再预览。",
                false,
                &format!("stage=session_preview; file_identity={source}_invalid"),
            )
        })?;
        if value.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_file_v1") {
            return Err(session_error(
                "session_preview_identity_unavailable",
                "会话文件身份方案不受当前预览支持。",
                "重新扫描会话目录后再预览。",
                false,
                &format!("stage=session_preview; file_identity={source}_unsupported"),
            ));
        }
        let device = value
            .get("device")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                session_error(
                    "session_preview_identity_unavailable",
                    "会话文件身份缺少设备标识。",
                    "重新扫描会话目录后再预览。",
                    false,
                    &format!("stage=session_preview; file_identity={source}_device_missing"),
                )
            })?;
        let inode = value
            .get("inode")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                session_error(
                    "session_preview_identity_unavailable",
                    "会话文件身份缺少文件标识。",
                    "重新扫描会话目录后再预览。",
                    false,
                    &format!("stage=session_preview; file_identity={source}_inode_missing"),
                )
            })?;
        Ok::<_, DomainError>((device, inode))
    };
    Ok(parse_identity(expected, "expected")? == parse_identity(current, "current")?)
}

fn parse_root_status(value: String) -> Result<ProfileSessionRootStatus, DomainError> {
    match value.as_str() {
        "active" => Ok(ProfileSessionRootStatus::Active),
        "offline" => Ok(ProfileSessionRootStatus::Offline),
        "replaced" => Ok(ProfileSessionRootStatus::Replaced),
        "revoked" => Ok(ProfileSessionRootStatus::Revoked),
        _ => Err(session_data_error("root_status", "unknown")),
    }
}

fn root_failure_status(error: &DomainError) -> Option<ProfileSessionRootStatus> {
    match error.code.as_str() {
        "session_root_replaced"
        | "session_root_symlink_rejected"
        | "session_root_not_directory"
        | "session_root_invalid"
        | "session_root_changed" => Some(ProfileSessionRootStatus::Replaced),
        "session_root_unavailable" => Some(ProfileSessionRootStatus::Offline),
        _ => None,
    }
}

fn root_status_text(status: ProfileSessionRootStatus) -> Result<&'static str, DomainError> {
    match status {
        ProfileSessionRootStatus::Active => Ok("active"),
        ProfileSessionRootStatus::Offline => Ok("offline"),
        ProfileSessionRootStatus::Replaced => Ok("replaced"),
        ProfileSessionRootStatus::Revoked => Ok("revoked"),
        ProfileSessionRootStatus::Unconfigured => Err(session_data_error(
            "root_status",
            "cannot_persist_unconfigured",
        )),
    }
}

fn parse_read_status(value: &str) -> Result<SessionReadStatus, DomainError> {
    match value {
        "readable" => Ok(SessionReadStatus::Readable),
        "partial" => Ok(SessionReadStatus::Partial),
        "unreadable" => Ok(SessionReadStatus::Unreadable),
        _ => Err(session_data_error("read_status", "unknown")),
    }
}

fn read_status_text(value: SessionReadStatus) -> &'static str {
    match value {
        SessionReadStatus::Readable => "readable",
        SessionReadStatus::Partial => "partial",
        SessionReadStatus::Unreadable => "unreadable",
    }
}

fn parse_freshness(value: &str) -> Result<SessionFreshness, DomainError> {
    match value {
        "fresh" => Ok(SessionFreshness::Fresh),
        "stale" => Ok(SessionFreshness::Stale),
        "missing" => Ok(SessionFreshness::Missing),
        "failed" => Ok(SessionFreshness::Failed),
        _ => Err(session_data_error("freshness", "unknown")),
    }
}

fn parse_bounded_string_array(value: &str, field: &str) -> Result<Vec<String>, DomainError> {
    if value.len() > MAXIMUM_JSON_BYTES {
        return Err(session_data_error(field, "too_large"));
    }
    let values: Vec<String> =
        serde_json::from_str(value).map_err(|_| session_data_error(field, "invalid_json"))?;
    if values.len() > 512 {
        return Err(session_data_error(field, "too_many"));
    }
    for value in &values {
        if value.is_empty() || value.len() > 2_048 || value.contains('\0') {
            return Err(session_data_error(field, "invalid_value"));
        }
    }
    Ok(values)
}

fn ensure_supported_target(target: &dyn ExecutionTarget) -> Result<(), DomainError> {
    if target.target_id() != TARGET_ID {
        return Err(session_error(
            "session_target_unavailable",
            "当前会话扫描仅支持本机执行目标。",
            "WSL 与 SSH 会话将在后续版本开放。",
            false,
            "stage=session_scan; target=non_local",
        ));
    }
    #[cfg(not(target_os = "linux"))]
    return Err(session_error(
        "session_platform_identity_unverified",
        "当前平台的会话文件身份尚未完成实机验证。",
        "等待该平台文件句柄与锁语义验证后再扫描。",
        false,
        "stage=session_scan; platform=unverified",
    ));
    #[cfg(target_os = "linux")]
    Ok(())
}

fn validate_project_id(value: i64) -> Result<(), DomainError> {
    if (1..=MAXIMUM_SAFE_JS_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(session_error(
            "project_id_invalid",
            "项目标识无效。",
            "刷新项目列表后重试。",
            false,
            "stage=session_service; project_id=invalid",
        ))
    }
}

fn validate_session_index_id(value: i64) -> Result<(), DomainError> {
    if (1..=MAXIMUM_SAFE_JS_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(session_error(
            "session_index_id_invalid",
            "会话索引标识无效。",
            "刷新会话列表后重试。",
            false,
            "stage=session_preview; session_index_id=invalid",
        ))
    }
}

fn path_to_text(path: &Path) -> Result<String, DomainError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        session_error(
            "session_path_not_utf8",
            "会话路径无法安全表示。",
            "当前版本仅支持 Unicode 会话路径。",
            false,
            "stage=session_service; path_encoding=non_utf8",
        )
    })
}

fn bounded_text(
    value: String,
    field: &str,
    maximum_characters: usize,
) -> Result<String, DomainError> {
    if !value.contains('\0') && value.chars().count() <= maximum_characters {
        Ok(value)
    } else {
        Err(session_data_error(field, "invalid_text"))
    }
}

fn validate_index_text(
    value: &str,
    field: &str,
    maximum_characters: usize,
    allow_path_controls: bool,
) -> Result<(), DomainError> {
    let display_control = value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            )
    });
    if !value.contains('\0')
        && value.chars().count() <= maximum_characters
        && (allow_path_controls || (!display_control && !value.contains('\u{fffd}')))
    {
        Ok(())
    } else {
        Err(session_data_error(field, "invalid_text"))
    }
}

fn nonnegative_u64(field: &str, value: i64) -> Result<u64, DomainError> {
    u64::try_from(value).map_err(|_| session_data_error(field, "negative"))
}

fn u64_to_i64(field: &str, value: u64) -> Result<i64, DomainError> {
    i64::try_from(value).map_err(|_| session_data_error(field, "out_of_range"))
}

fn epoch_millis_i64() -> Result<i64, DomainError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(millis).map_err(|_| session_data_error("timestamp", "out_of_range"))
}

fn project_not_found(stage: &str) -> DomainError {
    session_error(
        "project_not_found",
        "找不到要扫描会话的本机项目。",
        "刷新项目列表；如果项目已移除，请重新添加。",
        false,
        &format!("stage={stage}; project=missing"),
    )
}

fn push_file_diagnostic(diagnostics: &mut Vec<Diagnostic>, file_index: usize, error: DomainError) {
    push_diagnostic(
        diagnostics,
        Diagnostic::new(
            error.code,
            error.message,
            error.suggestion,
            error.retryable,
            format!(
                "file_index={file_index}; {}",
                error.technical_detail_redacted
            ),
        ),
    );
}

fn push_diagnostic(diagnostics: &mut Vec<Diagnostic>, diagnostic: Diagnostic) {
    if diagnostics.len() < MAXIMUM_DIAGNOSTICS {
        diagnostics.push(diagnostic);
    }
}

async fn spawn_session_task<T: Send + 'static>(
    stage: &'static str,
    operation: impl FnOnce() -> Result<T, DomainError> + Send + 'static,
) -> Result<T, DomainError> {
    tokio::task::spawn_blocking(operation).await.map_err(|_| {
        session_error(
            "session_database_task_failed",
            "会话数据库任务异常结束。",
            "重新扫描；若问题持续，请重新启动应用。",
            true,
            &format!("stage={stage}; task=join_failed"),
        )
    })?
}

fn session_database_error(stage: &str, error: &rusqlite::Error) -> DomainError {
    let detail = match error {
        rusqlite::Error::SqliteFailure(code, _) => format!(
            "sqlite_code={:?}; sqlite_extended_code={}",
            code.code, code.extended_code
        ),
        _ => format!("sqlite_error_kind={:?}", std::mem::discriminant(error)),
    };
    session_error(
        "session_database_failed",
        "无法读取或更新会话索引。",
        "确认元数据数据库可用后重试。",
        true,
        &format!("stage={stage}; {detail}"),
    )
}

fn session_data_error(field: &str, reason: &str) -> DomainError {
    session_error(
        "session_database_inconsistent",
        "会话索引包含无法识别的数据。",
        "保留数据库并重新扫描；不要直接修改索引。",
        false,
        &format!("stage=session_data; field={field}; reason={reason}"),
    )
}

fn session_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    detail: &str,
) -> DomainError {
    DomainError::new(code, message, suggestion, retryable, detail)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::fs;
    use std::io::Write;

    use tempfile::tempdir;

    use super::*;
    use crate::adapters::targets::LocalTarget;
    use crate::domain::{
        AccountPolicy, AddProjectRequest, TerminalMode, UpdateProjectBindingRequest,
    };
    use crate::services::ProjectService;

    fn add_request(profile: &str) -> AddProjectRequest {
        AddProjectRequest {
            profile: profile.to_owned(),
            terminal_mode: TerminalMode::Embedded,
            account_policy: AccountPolicy::Automatic,
        }
    }

    fn session_body(id: &str, cwd: &Path, title: &str) -> String {
        let header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": id,
            "timestamp": "2026-08-29T00:00:00Z",
            "cwd": cwd.to_string_lossy(),
            "title": title,
        });
        let model = serde_json::json!({
            "type": "model_change",
            "id": format!("{id}-model"),
            "parentId": null,
            "timestamp": "2026-08-29T00:00:01Z",
            "model": "synthetic-provider/model-a",
            "role": "default",
        });
        let message = serde_json::json!({
            "type": "message",
            "id": format!("{id}-message"),
            "parentId": format!("{id}-model"),
            "timestamp": "2026-08-29T00:00:02Z",
            "message": {
                "role": "user",
                "content": "sensitive body must not be persisted",
            },
        });
        format!("{header}\n{model}\n{message}\n")
    }

    async fn services(
        database_directory: &Path,
    ) -> (DatabaseRuntime, ProjectService, SessionService) {
        let runtime = DatabaseRuntime::pending(database_directory.to_owned());
        runtime
            .run_initialization()
            .expect("database initialization");
        let target = Arc::new(LocalTarget::default());
        (
            runtime.clone(),
            ProjectService::new(runtime.clone(), target.clone()),
            SessionService::new(runtime, target),
        )
    }

    #[tokio::test]
    async fn authorizes_scans_and_indexes_only_the_selected_project_metadata() {
        let database_directory = tempdir().expect("database");
        let first_directory = tempdir().expect("first project");
        let second_directory = tempdir().expect("second project");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-project");
        fs::create_dir(&session_directory).expect("session directory");
        let (runtime, projects, sessions) = services(database_directory.path()).await;
        let first = projects
            .add_project(first_directory.path().to_owned(), add_request("default"))
            .await
            .expect("first project")
            .project;
        projects
            .add_project(second_directory.path().to_owned(), add_request("default"))
            .await
            .expect("second project");
        fs::write(
            session_directory.join("first.jsonl"),
            session_body("session-first", first_directory.path(), "First"),
        )
        .expect("first session");
        fs::write(
            session_directory.join("second.jsonl"),
            session_body("session-second", second_directory.path(), "Second"),
        )
        .expect("second session");

        let snapshot = sessions
            .authorize_and_scan(first.id, sessions_root.path().to_owned())
            .await
            .expect("authorize and scan");
        assert_eq!(snapshot.root_status, ProfileSessionRootStatus::Active);
        assert!(!snapshot.profile_inventory_complete);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].session_id, "session-first");
        assert_eq!(snapshot.sessions[0].title, "First");
        assert_eq!(snapshot.sessions[0].freshness, SessionFreshness::Fresh);
        assert_eq!(snapshot.sessions[0].message_count, 1);

        let preview = sessions
            .preview(ProjectSessionPreviewRequest {
                project_id: first.id,
                session_index_id: snapshot.sessions[0].session_index_id,
            })
            .await
            .expect("on-demand preview");
        assert_eq!(preview.session_id, "session-first");
        assert_eq!(
            preview.first_message_summary.as_deref(),
            Some("sensitive body must not be persisted")
        );
        assert_eq!(preview.messages.len(), 1);
        assert_eq!(
            preview.messages[0].text,
            "sensitive body must not be persisted"
        );
        assert_eq!(
            preview.model_roles.get("default").map(String::as_str),
            Some("synthetic-provider/model-a")
        );

        let database = runtime.database().expect("database");
        let (body_count, root_count): (i64, i64) = database
            .with_connection(|connection| {
                let body_count = connection
                    .query_row(
                        "SELECT COUNT(*) FROM session_index
                         WHERE first_message_summary IS NOT NULL
                            OR instr(title, 'sensitive body') > 0",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| session_database_error("test_body_count", &error))?;
                let root_count = connection
                    .query_row(
                        "SELECT COUNT(*) FROM profile_session_roots
                         WHERE target_id = 'local' AND profile = 'default'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| session_database_error("test_root_count", &error))?;
                Ok((body_count, root_count))
            })
            .expect("database counts");
        assert_eq!(body_count, 0);
        assert_eq!(root_count, 1);
    }

    #[tokio::test]
    async fn marks_missing_sessions_only_after_a_complete_rescan() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-project");
        fs::create_dir(&session_directory).expect("session directory");
        let session_path = session_directory.join("session.jsonl");
        fs::write(
            &session_path,
            session_body("session-one", project_directory.path(), "One"),
        )
        .expect("session");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        sessions
            .authorize_and_scan(project.id, sessions_root.path().to_owned())
            .await
            .expect("first scan");
        fs::remove_file(session_path).expect("remove session");

        let snapshot = sessions.scan(project.id).await.expect("second scan");
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].freshness, SessionFreshness::Missing);
    }

    #[tokio::test]
    async fn previews_an_appended_stable_file_without_persisting_new_content() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-project");
        fs::create_dir(&session_directory).expect("session directory");
        let session_path = session_directory.join("session.jsonl");
        fs::write(
            &session_path,
            session_body("session-one", project_directory.path(), "One"),
        )
        .expect("session");
        let (runtime, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        let snapshot = sessions
            .authorize_and_scan(project.id, sessions_root.path().to_owned())
            .await
            .expect("scan");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&session_path)
            .expect("append session");
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "message",
                "id": "second-message",
                "parentId": "session-one-message",
                "timestamp": "2026-08-29T00:00:03Z",
                "message": {
                    "role": "assistant",
                    "content": "new in-memory preview only",
                },
            })
        )
        .expect("append message");

        let preview = sessions
            .preview(ProjectSessionPreviewRequest {
                project_id: project.id,
                session_index_id: snapshot.sessions[0].session_index_id,
            })
            .await
            .expect("preview appended file");
        assert_eq!(preview.message_count, 2);
        assert_eq!(
            preview.messages.last().map(|message| message.text.as_str()),
            Some("new in-memory preview only")
        );
        let indexed_message_count: i64 = runtime
            .database()
            .expect("database")
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT message_count FROM session_index WHERE id = ?1",
                        [snapshot.sessions[0].session_index_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| session_database_error("test_preview_message_count", &error))
            })
            .expect("indexed message count");
        assert_eq!(indexed_message_count, 1);
    }

    #[tokio::test]
    async fn rejects_a_replaced_session_file_until_the_index_is_refreshed() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-project");
        fs::create_dir(&session_directory).expect("session directory");
        let session_path = session_directory.join("session.jsonl");
        fs::write(
            &session_path,
            session_body("session-one", project_directory.path(), "One"),
        )
        .expect("session");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        let snapshot = sessions
            .authorize_and_scan(project.id, sessions_root.path().to_owned())
            .await
            .expect("scan");
        let replacement = session_directory.join("replacement.tmp");
        fs::write(
            &replacement,
            session_body("session-one", project_directory.path(), "Replacement"),
        )
        .expect("replacement");
        fs::rename(replacement, &session_path).expect("replace session");

        let error = sessions
            .preview(ProjectSessionPreviewRequest {
                project_id: project.id,
                session_index_id: snapshot.sessions[0].session_index_id,
            })
            .await
            .expect_err("replacement rejected");
        assert_eq!(error.code, "session_preview_file_replaced");
    }

    #[tokio::test]
    async fn does_not_preview_an_index_row_through_another_project() {
        let database_directory = tempdir().expect("database");
        let first_directory = tempdir().expect("first project");
        let second_directory = tempdir().expect("second project");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-projects");
        fs::create_dir(&session_directory).expect("session directory");
        fs::write(
            session_directory.join("first.jsonl"),
            session_body("session-first", first_directory.path(), "First"),
        )
        .expect("first session");
        fs::write(
            session_directory.join("second.jsonl"),
            session_body("session-second", second_directory.path(), "Second"),
        )
        .expect("second session");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let first = projects
            .add_project(first_directory.path().to_owned(), add_request("default"))
            .await
            .expect("first project")
            .project;
        let second = projects
            .add_project(second_directory.path().to_owned(), add_request("default"))
            .await
            .expect("second project")
            .project;
        sessions
            .authorize_and_scan(first.id, sessions_root.path().to_owned())
            .await
            .expect("authorize root");
        let second_snapshot = sessions.scan(second.id).await.expect("scan second");

        let error = sessions
            .preview(ProjectSessionPreviewRequest {
                project_id: first.id,
                session_index_id: second_snapshot.sessions[0].session_index_id,
            })
            .await
            .expect_err("cross-project preview rejected");
        assert_eq!(error.code, "session_preview_not_found");
    }

    #[tokio::test]
    async fn isolates_nested_project_ownership_and_continues_after_a_bad_file() {
        let database_directory = tempdir().expect("database");
        let root = tempdir().expect("root");
        let parent_path = root.path().join("parent");
        let child_path = parent_path.join("child");
        fs::create_dir_all(&child_path).expect("projects");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-projects");
        fs::create_dir(&session_directory).expect("session directory");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let parent = projects
            .add_project(parent_path, add_request("work"))
            .await
            .expect("parent")
            .project;
        let child = projects
            .add_project(child_path.clone(), add_request("work"))
            .await
            .expect("child")
            .project;
        fs::write(
            session_directory.join("child.jsonl"),
            session_body("child-session", &child_path, "Child"),
        )
        .expect("child session");
        fs::write(session_directory.join("broken.jsonl"), b"{not-json}\n").expect("broken session");

        let parent_snapshot = sessions
            .authorize_and_scan(parent.id, sessions_root.path().to_owned())
            .await
            .expect("parent scan");
        assert!(parent_snapshot.sessions.is_empty());
        assert!(!parent_snapshot.diagnostics.is_empty());
        let child_snapshot = sessions.scan(child.id).await.expect("child scan");
        assert_eq!(child_snapshot.sessions.len(), 1);
        assert_eq!(child_snapshot.sessions[0].session_id, "child-session");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_a_replaced_profile_session_root_and_persists_status() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let parent = tempdir().expect("session parent");
        let sessions_path = parent.path().join("sessions");
        let original_path = parent.path().join("sessions-original");
        fs::create_dir(&sessions_path).expect("sessions");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        sessions
            .authorize_and_scan(project.id, sessions_path.clone())
            .await
            .expect("authorize root");
        fs::rename(&sessions_path, &original_path).expect("move original root");
        std::os::unix::fs::symlink(&original_path, &sessions_path).expect("replacement symlink");

        let error = sessions
            .scan(project.id)
            .await
            .expect_err("replacement rejected");
        assert_eq!(error.code, "profile_session_root_replaced");
        let snapshot = sessions.snapshot(project.id).await.expect("snapshot");
        assert_eq!(snapshot.root_status, ProfileSessionRootStatus::Replaced);
    }

    #[tokio::test]
    async fn rejects_a_profile_change_that_occurs_while_the_picker_is_open() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let sessions_root = tempdir().expect("sessions root");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        let intent = sessions
            .prepare_root_authorization(project.id)
            .await
            .expect("authorization intent");
        projects
            .update_binding(UpdateProjectBindingRequest {
                project_id: project.id,
                expected_revision: project.binding.revision,
                profile: "changed".to_owned(),
                terminal_mode: TerminalMode::Embedded,
                account_policy: AccountPolicy::Automatic,
            })
            .await
            .expect("change profile");

        let error = sessions
            .authorize_and_scan_intent(intent, sessions_root.path().to_owned())
            .await
            .expect_err("stale picker intent rejected");
        assert_eq!(error.code, "session_profile_binding_changed");
        let snapshot = sessions.snapshot(project.id).await.expect("snapshot");
        assert_eq!(snapshot.profile, "changed");
        assert_eq!(snapshot.root_status, ProfileSessionRootStatus::Unconfigured);
    }

    #[tokio::test]
    async fn holds_the_profile_scope_while_a_picker_intent_is_alive() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        let first_intent = sessions
            .prepare_root_authorization(project.id)
            .await
            .expect("first intent");

        let error = sessions
            .prepare_root_authorization(project.id)
            .await
            .expect_err("second picker rejected");
        assert_eq!(error.code, "session_scan_in_progress");
        drop(first_intent);
        sessions
            .prepare_root_authorization(project.id)
            .await
            .expect("scope released");
    }

    #[tokio::test]
    async fn rejects_overlapping_session_roots_across_profiles() {
        let database_directory = tempdir().expect("database");
        let first_project = tempdir().expect("first project");
        let second_project = tempdir().expect("second project");
        let root = tempdir().expect("root");
        let nested = root.path().join("nested");
        fs::create_dir(&nested).expect("nested root");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let first = projects
            .add_project(first_project.path().to_owned(), add_request("first"))
            .await
            .expect("first project")
            .project;
        let second = projects
            .add_project(second_project.path().to_owned(), add_request("second"))
            .await
            .expect("second project")
            .project;
        sessions
            .authorize_and_scan(first.id, root.path().to_owned())
            .await
            .expect("first root");

        let error = sessions
            .authorize_and_scan(second.id, nested)
            .await
            .expect_err("overlap rejected");
        assert_eq!(error.code, "session_root_overlaps_profile");
    }

    #[tokio::test]
    async fn rejects_oversized_structured_metadata_before_it_can_poison_the_index() {
        let database_directory = tempdir().expect("database");
        let project_directory = tempdir().expect("project");
        let sessions_root = tempdir().expect("sessions root");
        let session_directory = sessions_root.path().join("-project");
        fs::create_dir(&session_directory).expect("session directory");
        let (_, projects, sessions) = services(database_directory.path()).await;
        let project = projects
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project")
            .project;
        let header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": "oversized-metadata",
            "timestamp": "2026-08-29T00:00:00Z",
            "cwd": project_directory.path().to_string_lossy(),
        });
        let mut body = format!("{header}\n");
        let mut parent: Option<String> = None;
        for index in 0..513 {
            let id = format!("pin-{index}");
            body.push_str(
                &serde_json::json!({
                    "type": "credential_pin",
                    "id": id,
                    "parentId": parent,
                    "timestamp": "2026-08-29T00:00:01Z",
                    "provider": format!("provider-{index}"),
                    "hash": "a".repeat(64),
                })
                .to_string(),
            );
            body.push('\n');
            parent = Some(format!("pin-{index}"));
        }
        fs::write(session_directory.join("oversized.jsonl"), body)
            .expect("oversized session metadata");

        let snapshot = sessions
            .authorize_and_scan(project.id, sessions_root.path().to_owned())
            .await
            .expect("scan completes with diagnostic");
        assert!(snapshot.sessions.is_empty());
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "session_database_inconsistent"));
        assert!(sessions
            .snapshot(project.id)
            .await
            .expect("clean cached snapshot")
            .sessions
            .is_empty());
    }
}
