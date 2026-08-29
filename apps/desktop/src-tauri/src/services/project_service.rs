use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};

use crate::adapters::editors::{CursorEditorAdapter, ExternalEditorAdapter};
use crate::adapters::targets::{ExecutionTarget, GitIdentity};
use crate::domain::{is_valid_profile, AccountPolicy};
use crate::domain::{
    AddProjectRequest, AddProjectResult, Diagnostic, DomainError, ExternalEditorId, KnownProfile,
    KnownProfileSource, OpenProjectInEditorRequest, OpenProjectInEditorResult,
    ProjectAuthorizationStatus, ProjectBinding, ProjectGitIdentity, ProjectSummary,
    ProjectWorkspaceSnapshot, SettingSource, TerminalMode, UpdateProjectBindingRequest,
};
use crate::infrastructure::db::{Database, DatabaseRuntime};
use crate::infrastructure::secrets::redact;

const TARGET_ID: &str = "local";
const MAXIMUM_PATH_BYTES: usize = 32_768;
const MAXIMUM_JSON_BYTES: usize = 65_536;
const MAXIMUM_LIST_ITEMS: usize = 512;
const MAXIMUM_ROLE_DEFAULTS: usize = 64;
const MAXIMUM_TEXT_BYTES: usize = 2_048;
const MAXIMUM_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct ProjectService {
    database: DatabaseRuntime,
    target: Arc<dyn ExecutionTarget>,
    editor: Arc<dyn ExternalEditorAdapter>,
    opening_projects: Arc<Mutex<HashSet<i64>>>,
}

impl fmt::Debug for ProjectService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectService")
            .field("target_id", &self.target.target_id())
            .field("editor_id", &self.editor.editor_id())
            .finish_non_exhaustive()
    }
}

impl ProjectService {
    pub fn new(database: DatabaseRuntime, target: Arc<dyn ExecutionTarget>) -> Self {
        Self::with_editor(database, target, Arc::new(CursorEditorAdapter::default()))
    }

    pub fn with_editor(
        database: DatabaseRuntime,
        target: Arc<dyn ExecutionTarget>,
        editor: Arc<dyn ExternalEditorAdapter>,
    ) -> Self {
        Self {
            database,
            target,
            editor,
            opening_projects: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub async fn workspace(&self) -> Result<ProjectWorkspaceSnapshot, DomainError> {
        let database = self.database.clone();
        spawn_database_task("load_workspace", move || {
            let database = database.database()?;
            database.with_connection(load_workspace)
        })
        .await
    }

    pub async fn add_project(
        &self,
        selected_path: PathBuf,
        request: AddProjectRequest,
    ) -> Result<AddProjectResult, DomainError> {
        validate_binding_input(
            &request.profile,
            request.terminal_mode,
            request.account_policy,
        )?;
        if self.target.target_id() != TARGET_ID {
            return Err(project_error(
                "project_target_unavailable",
                "当前项目切片仅支持本机执行目标。",
                "请选择本机目录；WSL 与 SSH 目标将在后续版本开放。",
                false,
                "stage=add_project; target=non_local",
            ));
        }

        let authorized = self.target.authorize_directory(&selected_path).await?;
        let canonical_path = path_to_text(&authorized.canonical_path, "canonical_path")?;
        let display_path = path_to_text(&selected_path, "display_path")?;
        validate_path_text(&canonical_path, "canonical_path")?;
        validate_path_text(&display_path, "display_path")?;
        if authorized.stable_identity_json.len() > MAXIMUM_JSON_BYTES {
            return Err(project_error(
                "project_identity_too_large",
                "项目目录身份数据超过支持上限。",
                "请选择普通本地文件系统中的目录。",
                false,
                "stage=add_project; stable_identity=too_large",
            ));
        }

        let mut diagnostics = Vec::new();
        let git_identity = match self
            .target
            .resolve_git_identity(&authorized.canonical_path)
            .await
        {
            Ok(identity) => convert_git_identity(identity, &mut diagnostics),
            Err(error) => {
                diagnostics.push(error.into());
                None
            }
        };
        let canonical_key = canonical_path_key(&canonical_path);
        let now = epoch_millis_i64()?;
        let database = self.database.clone();
        let profile = request.profile;
        let stable_identity_json = authorized.stable_identity_json;
        let (project, created) = spawn_database_task("persist_project", move || {
            let database = database.database()?;
            persist_project(
                &database,
                PersistProjectInput {
                    canonical_path,
                    canonical_key,
                    display_path,
                    stable_identity_json,
                    git_identity,
                    profile,
                    terminal_mode: request.terminal_mode,
                    account_policy: request.account_policy,
                    now,
                },
            )
        })
        .await?;

        if !created {
            diagnostics.push(Diagnostic::new(
                "project_already_registered",
                "该目录已经登记为项目。",
                "现有项目绑定保持不变；如需修改 Profile，请使用项目卡片中的绑定设置。",
                false,
                "stage=add_project; outcome=existing",
            ));
        }
        Ok(AddProjectResult {
            project,
            diagnostics,
        })
    }

    pub async fn update_binding(
        &self,
        request: UpdateProjectBindingRequest,
    ) -> Result<ProjectSummary, DomainError> {
        validate_project_id(request.project_id)?;
        validate_binding_input(
            &request.profile,
            request.terminal_mode,
            request.account_policy,
        )?;
        if request.expected_revision == 0 || request.expected_revision > i64::MAX as u64 {
            return Err(project_error(
                "project_binding_revision_invalid",
                "项目绑定版本无效。",
                "刷新项目列表后重试。",
                false,
                "stage=update_binding; revision=out_of_range",
            ));
        }

        let database = self.database.clone();
        spawn_database_task("update_binding", move || {
            let database = database.database()?;
            update_project_binding(&database, request)
        })
        .await
    }

    pub async fn open_in_editor(
        &self,
        request: OpenProjectInEditorRequest,
    ) -> Result<OpenProjectInEditorResult, DomainError> {
        validate_project_id(request.project_id)?;
        let _open_guard = self.acquire_editor_open(request.project_id)?;
        if request.editor_id != ExternalEditorId::Cursor || self.editor.editor_id() != "cursor" {
            return Err(project_error(
                "project_editor_unsupported",
                "当前版本只支持固定的 Cursor 桌面编辑器。",
                "选择 Cursor；自定义编辑器命令不会开放。",
                false,
                "stage=open_project_editor; editor=unsupported",
            ));
        }
        if self.target.target_id() != TARGET_ID {
            return Err(project_error(
                "project_editor_target_unavailable",
                "当前仅支持在本机打开 Cursor。",
                "WSL 与 SSH 项目将在后续版本提供独立编辑器适配。",
                false,
                "stage=open_project_editor; target=non_local",
            ));
        }
        #[cfg(windows)]
        {
            return Err(project_error(
                "project_editor_windows_identity_unverified",
                "Windows 项目目录身份尚未完成实机验证。",
                "请等待 Windows 文件身份与 ACL 验证完成后再使用此动作。",
                false,
                "stage=open_project_editor; platform=windows_unverified",
            ));
        }

        #[cfg(not(windows))]
        {
            let database = self.database.clone();
            let project_id = request.project_id;
            let record = spawn_database_task("load_project_editor_record", move || {
                let database = database.database()?;
                database.with_connection(|connection| {
                    load_project_editor_record(connection, project_id)
                })
            })
            .await?;
            if matches!(
                record.authorization_status,
                ProjectAuthorizationStatus::Revoked | ProjectAuthorizationStatus::Missing
            ) {
                return Err(project_error(
                    "project_authorization_inactive",
                    "项目目录当前没有可用授权。",
                    "通过系统目录选择器重新添加或重新授权项目。",
                    false,
                    "stage=open_project_editor; authorization=inactive",
                ));
            }

            self.revalidate_project_directory(&record, true).await?;
            let editor = self.editor.probe().await?;
            let canonical_path = self.revalidate_project_directory(&record, false).await?;
            let stable_identity_json = record
                .stable_identity_json
                .as_deref()
                .ok_or_else(|| project_data_error("stable_identity_json", "missing"))?;
            let launch = match self
                .editor
                .open_directory(&editor, &canonical_path, stable_identity_json)
                .await
            {
                Ok(launch) => launch,
                Err(error) if error.code == "cursor_project_identity_changed" => {
                    self.set_authorization_status(&record, ProjectAuthorizationStatus::Replaced)
                        .await?;
                    return Err(error);
                }
                Err(error) if error.code == "cursor_project_path_invalid" => {
                    self.set_authorization_status(&record, ProjectAuthorizationStatus::Offline)
                        .await?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            Ok(OpenProjectInEditorResult {
                project_id: request.project_id,
                editor_id: request.editor_id,
                process_id: launch.process_id,
            })
        }
    }

    fn acquire_editor_open(&self, project_id: i64) -> Result<ProjectEditorOpenGuard, DomainError> {
        let mut opening = self.opening_projects.lock().map_err(|_| {
            project_error(
                "project_editor_registry_poisoned",
                "项目编辑器启动状态不可用。",
                "重新启动应用后重试。",
                false,
                "stage=open_project_editor; registry=poisoned",
            )
        })?;
        if !opening.insert(project_id) {
            return Err(project_error(
                "project_editor_open_in_progress",
                "该项目正在启动 Cursor。",
                "等待当前启动完成，避免重复打开窗口。",
                true,
                "stage=open_project_editor; duplicate=active",
            ));
        }
        Ok(ProjectEditorOpenGuard {
            project_id,
            opening_projects: Arc::clone(&self.opening_projects),
        })
    }

    #[cfg(not(windows))]
    async fn revalidate_project_directory(
        &self,
        record: &ProjectEditorRecord,
        persist_active_status: bool,
    ) -> Result<PathBuf, DomainError> {
        let stored_path = PathBuf::from(&record.canonical_path);
        let current = match self.target.authorize_directory(&stored_path).await {
            Ok(current) => current,
            Err(error) => {
                self.set_authorization_status(record, ProjectAuthorizationStatus::Offline)
                    .await?;
                return Err(project_error(
                    "project_authorization_offline",
                    "项目目录当前不可访问。",
                    "恢复目录或权限后重试；管理器不会改用其他路径。",
                    true,
                    &format!(
                        "stage=open_project_editor; authorization=offline; cause={}",
                        error.code
                    ),
                ));
            }
        };
        let current_path = path_to_text(&current.canonical_path, "current_canonical_path")?;
        let identity_matches =
            stable_identity_matches(&record.stable_identity_json, &current.stable_identity_json)?;
        if current_path != record.canonical_path || !identity_matches {
            self.set_authorization_status(record, ProjectAuthorizationStatus::Replaced)
                .await?;
            return Err(project_error(
                "project_authorization_replaced",
                "项目路径在授权后指向了不同目录。",
                "重新选择并授权预期目录；当前操作已安全停止。",
                false,
                "stage=open_project_editor; authorization=replaced",
            ));
        }

        if persist_active_status {
            self.set_authorization_status(record, ProjectAuthorizationStatus::Active)
                .await?;
        }
        Ok(current.canonical_path)
    }

    #[cfg(not(windows))]
    async fn set_authorization_status(
        &self,
        record: &ProjectEditorRecord,
        status: ProjectAuthorizationStatus,
    ) -> Result<(), DomainError> {
        let database = self.database.clone();
        let canonical_key = record.canonical_key.clone();
        let stable_identity_json = record
            .stable_identity_json
            .clone()
            .ok_or_else(|| project_data_error("stable_identity_json", "missing"))?;
        spawn_database_task("update_project_authorization", move || {
            let database = database.database()?;
            update_project_authorization(&database, &canonical_key, &stable_identity_json, status)
        })
        .await
    }

    pub async fn resolve_binding_for_path(
        &self,
        path: &Path,
    ) -> Result<Option<ProjectBinding>, DomainError> {
        let canonical = self.target.canonicalize_path(path).await?;
        let database = self.database.clone();
        let projects = spawn_database_task("resolve_binding", move || {
            let database = database.database()?;
            database.with_connection(load_projects)
        })
        .await?;

        Ok(projects
            .into_iter()
            .filter(|project| {
                canonical.starts_with(Path::new(project.binding.path_prefix.as_str()))
            })
            .max_by_key(|project| {
                Path::new(project.binding.path_prefix.as_str())
                    .components()
                    .count()
            })
            .map(|project| project.binding))
    }
}

struct ProjectEditorOpenGuard {
    project_id: i64,
    opening_projects: Arc<Mutex<HashSet<i64>>>,
}

impl Drop for ProjectEditorOpenGuard {
    fn drop(&mut self) {
        if let Ok(mut opening) = self.opening_projects.lock() {
            opening.remove(&self.project_id);
        }
    }
}

#[cfg(not(windows))]
struct ProjectEditorRecord {
    canonical_path: String,
    canonical_key: String,
    authorization_status: ProjectAuthorizationStatus,
    stable_identity_json: Option<String>,
}

#[cfg(not(windows))]
fn load_project_editor_record(
    connection: &rusqlite::Connection,
    project_id: i64,
) -> Result<ProjectEditorRecord, DomainError> {
    let row = connection
        .query_row(
            "SELECT
                project.canonical_path,
                project.canonical_key,
                root.status,
                root.stable_identity_json
             FROM projects AS project
             LEFT JOIN authorized_roots AS root
               ON root.target_id = project.target_id
              AND root.kind = 'project'
              AND root.canonical_key = project.canonical_key
             WHERE project.target_id = ?1 AND project.id = ?2",
            params![TARGET_ID, project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| project_database_error("load_project_editor_record", &error))?
        .ok_or_else(|| {
            project_error(
                "project_not_found",
                "找不到要用 Cursor 打开的本机项目。",
                "刷新项目列表；如果项目已移除，请重新添加。",
                false,
                "stage=open_project_editor; project=missing",
            )
        })?;
    validate_path_text(&row.0, "canonical_path")?;
    validate_path_text(&row.1, "canonical_key")?;
    if row
        .3
        .as_ref()
        .is_some_and(|identity| identity.len() > MAXIMUM_JSON_BYTES)
    {
        return Err(project_data_error("stable_identity_json", "too_large"));
    }

    Ok(ProjectEditorRecord {
        canonical_path: row.0,
        canonical_key: row.1,
        authorization_status: parse_authorization_status(row.2)?,
        stable_identity_json: row.3,
    })
}

#[cfg(not(windows))]
fn stable_identity_matches(expected: &Option<String>, current: &str) -> Result<bool, DomainError> {
    let expected = expected
        .as_ref()
        .ok_or_else(|| project_data_error("stable_identity_json", "missing"))?;
    if current.len() > MAXIMUM_JSON_BYTES {
        return Err(project_error(
            "project_identity_too_large",
            "项目目录身份数据超过支持上限。",
            "重新授权普通本地文件系统中的目录。",
            false,
            "stage=open_project_editor; current_identity=too_large",
        ));
    }
    let expected: serde_json::Value = serde_json::from_str(expected)
        .map_err(|_| project_data_error("stable_identity_json", "invalid_json"))?;
    let current: serde_json::Value = serde_json::from_str(current).map_err(|_| {
        project_error(
            "project_identity_invalid",
            "无法验证当前项目目录身份。",
            "重新授权项目目录后重试。",
            false,
            "stage=open_project_editor; current_identity=invalid_json",
        )
    })?;
    #[cfg(unix)]
    if expected.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_dev_ino_v1")
        || current.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_dev_ino_v1")
    {
        return Err(project_data_error(
            "stable_identity_json",
            "unsupported_scheme",
        ));
    }
    Ok(expected == current)
}

#[cfg(not(windows))]
fn update_project_authorization(
    database: &Database,
    canonical_key: &str,
    stable_identity_json: &str,
    status: ProjectAuthorizationStatus,
) -> Result<(), DomainError> {
    let now = epoch_millis_i64()?;
    let status = authorization_status_text(status)?;
    let changed = database.with_connection(|connection| {
        connection
            .execute(
                "UPDATE authorized_roots
                 SET status = ?1,
                     last_verified_at_epoch_ms = ?2
                 WHERE target_id = ?3
                   AND kind = 'project'
                   AND canonical_key = ?4
                   AND stable_identity_json = ?5",
                params![status, now, TARGET_ID, canonical_key, stable_identity_json,],
            )
            .map_err(|error| project_database_error("update_project_authorization", &error))
    })?;
    if changed != 1 {
        return Err(project_error(
            "project_authorization_conflict",
            "项目授权在验证期间发生变化。",
            "刷新项目列表并重新执行操作。",
            true,
            "stage=open_project_editor; authorization_update=conflict",
        ));
    }
    Ok(())
}

struct PersistProjectInput {
    canonical_path: String,
    canonical_key: String,
    display_path: String,
    stable_identity_json: String,
    git_identity: Option<ProjectGitIdentity>,
    profile: String,
    terminal_mode: TerminalMode,
    account_policy: AccountPolicy,
    now: i64,
}

fn persist_project(
    database: &Database,
    input: PersistProjectInput,
) -> Result<(ProjectSummary, bool), DomainError> {
    database.with_connection_mut(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| project_database_error("begin_add_project", &error))?;
        let git_common_directory = input
            .git_identity
            .as_ref()
            .map(|identity| identity.common_directory.as_str());
        let git_relative_path = input
            .git_identity
            .as_ref()
            .map(|identity| identity.repository_relative_path.as_str());
        let inserted = transaction
            .execute(
                "INSERT INTO projects (
                    target_id,
                    canonical_path,
                    canonical_key,
                    display_path,
                    git_common_directory,
                    git_relative_path,
                    created_at_epoch_ms,
                    last_used_at_epoch_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(target_id, canonical_key) DO NOTHING",
                params![
                    TARGET_ID,
                    input.canonical_path,
                    input.canonical_key,
                    input.display_path,
                    git_common_directory,
                    git_relative_path,
                    input.now,
                ],
            )
            .map_err(|error| project_database_error("insert_project", &error))?
            == 1;
        let project_id: i64 = transaction
            .query_row(
                "SELECT id FROM projects WHERE target_id = ?1 AND canonical_key = ?2",
                params![TARGET_ID, input.canonical_key],
                |row| row.get(0),
            )
            .map_err(|error| project_database_error("resolve_project", &error))?;
        validate_project_id(project_id)?;

        transaction
            .execute(
                "INSERT INTO authorized_roots (
                    target_id,
                    kind,
                    canonical_path,
                    canonical_key,
                    display_path,
                    stable_identity_json,
                    grant_metadata_json,
                    status,
                    granted_at_epoch_ms,
                    last_verified_at_epoch_ms
                ) VALUES (?1, 'project', ?2, ?3, ?4, ?5, '{\"source\":\"native_picker\"}',
                          'active', ?6, ?6)
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
                    input.now,
                ],
            )
            .map_err(|error| project_database_error("upsert_authorized_root", &error))?;

        let binding_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM project_bindings
                    WHERE target_id = ?1 AND project_id = ?2
                )",
                params![TARGET_ID, project_id],
                |row| row.get(0),
            )
            .map_err(|error| project_database_error("inspect_project_binding", &error))?;
        if !binding_exists {
            transaction
                .execute(
                    "INSERT INTO project_bindings (
                        target_id,
                        project_id,
                        path_prefix,
                        path_prefix_key,
                        profile,
                        terminal_mode,
                        account_policy,
                        updated_at_epoch_ms,
                        revision
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
                    params![
                        TARGET_ID,
                        project_id,
                        input.canonical_path,
                        input.canonical_key,
                        input.profile,
                        terminal_mode_text(input.terminal_mode),
                        account_policy_text(input.account_policy),
                        input.now,
                    ],
                )
                .map_err(|error| project_database_error("insert_project_binding", &error))?;
        }

        transaction
            .commit()
            .map_err(|error| project_database_error("commit_add_project", &error))?;
        let project = load_project(connection, project_id)?;
        Ok((project, inserted))
    })
}

fn update_project_binding(
    database: &Database,
    request: UpdateProjectBindingRequest,
) -> Result<ProjectSummary, DomainError> {
    let now = epoch_millis_i64()?;
    database.with_connection_mut(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| project_database_error("begin_update_binding", &error))?;
        let changed = transaction
            .execute(
                "UPDATE project_bindings
                 SET profile = ?1,
                     terminal_mode = ?2,
                     account_policy = ?3,
                     credential_ref_id = NULL,
                     updated_at_epoch_ms = ?4,
                     revision = revision + 1
                 WHERE target_id = ?5
                   AND project_id = ?6
                   AND revision = ?7",
                params![
                    request.profile,
                    terminal_mode_text(request.terminal_mode),
                    account_policy_text(request.account_policy),
                    now,
                    TARGET_ID,
                    request.project_id,
                    request.expected_revision as i64,
                ],
            )
            .map_err(|error| project_database_error("update_project_binding", &error))?;
        if changed == 0 {
            let current_revision: Option<i64> = transaction
                .query_row(
                    "SELECT revision FROM project_bindings
                     WHERE target_id = ?1 AND project_id = ?2",
                    params![TARGET_ID, request.project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| project_database_error("inspect_binding_conflict", &error))?;
            return Err(match current_revision {
                Some(_) => project_error(
                    "project_binding_conflict",
                    "项目绑定已在其他操作中更新。",
                    "刷新项目列表，确认最新设置后再保存。",
                    true,
                    "stage=update_binding; outcome=revision_conflict",
                ),
                None => project_error(
                    "project_not_found",
                    "找不到要更新的本机项目。",
                    "刷新项目列表；如果项目已被移除，请重新添加。",
                    false,
                    "stage=update_binding; outcome=not_found",
                ),
            });
        }
        transaction
            .commit()
            .map_err(|error| project_database_error("commit_update_binding", &error))?;
        load_project(connection, request.project_id)
    })
}

fn load_workspace(
    connection: &rusqlite::Connection,
) -> Result<ProjectWorkspaceSnapshot, DomainError> {
    let projects = load_projects(connection)?;
    let mut profiles = BTreeMap::from([("default".to_owned(), KnownProfileSource::Default)]);
    for project in &projects {
        profiles
            .entry(project.binding.profile.clone())
            .or_insert(KnownProfileSource::ProjectBinding);
    }
    let known_profiles = profiles
        .into_iter()
        .map(|(name, source)| KnownProfile {
            name,
            source,
            agent_directory: None,
            is_complete_inventory: false,
        })
        .collect();
    Ok(ProjectWorkspaceSnapshot {
        projects,
        known_profiles,
    })
}

fn load_project(
    connection: &rusqlite::Connection,
    project_id: i64,
) -> Result<ProjectSummary, DomainError> {
    load_projects(connection)?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| {
            project_error(
                "project_not_found",
                "找不到请求的本机项目。",
                "刷新项目列表后重试。",
                false,
                "stage=load_project; outcome=not_found",
            )
        })
}

fn load_projects(connection: &rusqlite::Connection) -> Result<Vec<ProjectSummary>, DomainError> {
    let mut statement = connection
        .prepare(
            "SELECT
                project.id,
                project.target_id,
                project.canonical_path,
                project.display_path,
                project.git_common_directory,
                project.git_relative_path,
                project.created_at_epoch_ms,
                project.last_used_at_epoch_ms,
                root.status,
                binding.id,
                binding.revision,
                binding.path_prefix,
                binding.profile,
                binding.terminal_mode,
                binding.account_policy,
                binding.allowed_models_json,
                binding.disabled_providers_json,
                binding.updated_at_epoch_ms
             FROM projects AS project
             LEFT JOIN authorized_roots AS root
               ON root.target_id = project.target_id
              AND root.kind = 'project'
              AND root.canonical_key = project.canonical_key
             LEFT JOIN project_bindings AS binding
               ON binding.target_id = project.target_id
              AND binding.project_id = project.id
             WHERE project.target_id = ?1
             ORDER BY project.last_used_at_epoch_ms DESC, project.id ASC",
        )
        .map_err(|error| project_database_error("prepare_project_list", &error))?;
    let rows = statement
        .query_map([TARGET_ID], read_project_row)
        .map_err(|error| project_database_error("query_project_list", &error))?;
    let mut raw_projects = Vec::new();
    for row in rows {
        raw_projects
            .push(row.map_err(|error| project_database_error("decode_project_row", &error))?);
        if raw_projects.len() > MAXIMUM_LIST_ITEMS {
            return Err(project_data_error("project_count", "too_many"));
        }
    }
    drop(statement);

    let mut projects = Vec::with_capacity(raw_projects.len());
    let mut project_ids = HashSet::new();
    for raw in raw_projects {
        if !project_ids.insert(raw.id) {
            return Err(project_data_error(
                "project_binding",
                "multiple_direct_bindings",
            ));
        }
        projects.push(decode_project_row(connection, raw)?);
    }
    Ok(projects)
}

struct ProjectDatabaseRow {
    id: i64,
    target_id: String,
    canonical_path: String,
    display_path: String,
    git_common_directory: Option<String>,
    git_relative_path: Option<String>,
    created_at_epoch_ms: i64,
    last_used_at_epoch_ms: i64,
    authorization_status: Option<String>,
    binding_id: Option<i64>,
    binding_revision: Option<i64>,
    path_prefix: Option<String>,
    profile: Option<String>,
    terminal_mode: Option<String>,
    account_policy: Option<String>,
    allowed_models_json: Option<String>,
    disabled_providers_json: Option<String>,
    binding_updated_at_epoch_ms: Option<i64>,
}

fn read_project_row(row: &Row<'_>) -> rusqlite::Result<ProjectDatabaseRow> {
    Ok(ProjectDatabaseRow {
        id: row.get(0)?,
        target_id: row.get(1)?,
        canonical_path: row.get(2)?,
        display_path: row.get(3)?,
        git_common_directory: row.get(4)?,
        git_relative_path: row.get(5)?,
        created_at_epoch_ms: row.get(6)?,
        last_used_at_epoch_ms: row.get(7)?,
        authorization_status: row.get(8)?,
        binding_id: row.get(9)?,
        binding_revision: row.get(10)?,
        path_prefix: row.get(11)?,
        profile: row.get(12)?,
        terminal_mode: row.get(13)?,
        account_policy: row.get(14)?,
        allowed_models_json: row.get(15)?,
        disabled_providers_json: row.get(16)?,
        binding_updated_at_epoch_ms: row.get(17)?,
    })
}

fn decode_project_row(
    connection: &rusqlite::Connection,
    row: ProjectDatabaseRow,
) -> Result<ProjectSummary, DomainError> {
    validate_project_id(row.id)?;
    validate_path_text(&row.canonical_path, "canonical_path")?;
    validate_path_text(&row.display_path, "display_path")?;
    if row.target_id != TARGET_ID {
        return Err(project_data_error("target_id", "unexpected"));
    }
    let binding_id = row
        .binding_id
        .ok_or_else(|| project_data_error("project_binding", "missing"))?;
    validate_project_id(binding_id)?;
    let revision = positive_u64(
        row.binding_revision
            .ok_or_else(|| project_data_error("binding_revision", "missing"))?,
        "binding_revision",
    )?;
    let path_prefix = required_text(row.path_prefix, "path_prefix", MAXIMUM_PATH_BYTES)?;
    let profile = required_text(row.profile, "profile", 64)?;
    if !is_valid_profile(&profile) {
        return Err(project_data_error("profile", "invalid"));
    }
    let terminal_mode =
        parse_terminal_mode(required_text(row.terminal_mode, "terminal_mode", 32)?)?;
    let account_policy =
        parse_account_policy(required_text(row.account_policy, "account_policy", 32)?)?;
    let allowed_models = parse_string_list(
        required_text(
            row.allowed_models_json,
            "allowed_models_json",
            MAXIMUM_JSON_BYTES,
        )?,
        "allowed_models_json",
    )?;
    let disabled_providers = parse_string_list(
        required_text(
            row.disabled_providers_json,
            "disabled_providers_json",
            MAXIMUM_JSON_BYTES,
        )?,
        "disabled_providers_json",
    )?;
    let role_defaults = load_role_defaults(connection, binding_id)?;
    let git_identity = match (row.git_common_directory, row.git_relative_path) {
        (None, None) => None,
        (Some(common_directory), Some(repository_relative_path)) => {
            validate_path_text(&common_directory, "git_common_directory")?;
            validate_path_text(&repository_relative_path, "git_relative_path")?;
            Some(ProjectGitIdentity {
                common_directory,
                repository_relative_path,
            })
        }
        _ => return Err(project_data_error("git_identity", "partial")),
    };

    Ok(ProjectSummary {
        id: row.id,
        target_id: row.target_id,
        canonical_path: row.canonical_path,
        display_path: row.display_path,
        git_identity,
        created_at_epoch_ms: nonnegative_u64(row.created_at_epoch_ms, "created_at")?,
        last_used_at_epoch_ms: nonnegative_u64(row.last_used_at_epoch_ms, "last_used_at")?,
        authorization_status: parse_authorization_status(row.authorization_status)?,
        binding: ProjectBinding {
            id: binding_id,
            revision,
            path_prefix,
            profile,
            profile_source: SettingSource::Project,
            terminal_mode,
            terminal_mode_source: SettingSource::Project,
            account_policy,
            account_policy_source: SettingSource::Project,
            role_defaults,
            allowed_models,
            disabled_providers,
            updated_at_epoch_ms: nonnegative_u64(
                row.binding_updated_at_epoch_ms
                    .ok_or_else(|| project_data_error("binding_updated_at", "missing"))?,
                "binding_updated_at",
            )?,
        },
    })
}

fn load_role_defaults(
    connection: &rusqlite::Connection,
    binding_id: i64,
) -> Result<BTreeMap<String, String>, DomainError> {
    let mut statement = connection
        .prepare(
            "SELECT role, model_selector
             FROM project_role_defaults
             WHERE target_id = ?1 AND binding_id = ?2
             ORDER BY role ASC",
        )
        .map_err(|error| project_database_error("prepare_role_defaults", &error))?;
    let rows = statement
        .query_map(params![TARGET_ID, binding_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| project_database_error("query_role_defaults", &error))?;
    let mut values = BTreeMap::new();
    for row in rows {
        let (role, selector) =
            row.map_err(|error| project_database_error("decode_role_default", &error))?;
        validate_bounded_text(&role, "role", MAXIMUM_TEXT_BYTES)?;
        validate_bounded_text(&selector, "model_selector", MAXIMUM_TEXT_BYTES)?;
        if values.insert(role, selector).is_some() || values.len() > MAXIMUM_ROLE_DEFAULTS {
            return Err(project_data_error("role_defaults", "invalid_count"));
        }
    }
    Ok(values)
}

fn parse_string_list(value: String, field: &str) -> Result<Vec<String>, DomainError> {
    let values: Vec<String> =
        serde_json::from_str(&value).map_err(|_| project_data_error(field, "invalid_json"))?;
    if values.len() > MAXIMUM_LIST_ITEMS {
        return Err(project_data_error(field, "too_many_items"));
    }
    for value in &values {
        validate_bounded_text(value, field, MAXIMUM_TEXT_BYTES)?;
    }
    Ok(values)
}

fn convert_git_identity(
    identity: Option<GitIdentity>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<ProjectGitIdentity> {
    let identity = identity?;
    let Some(common_directory) = identity.common_directory.to_str() else {
        diagnostics.push(Diagnostic::new(
            "git_identity_not_utf8",
            "Git common directory 无法安全表示。",
            "项目仍会添加，但不会保存 Git 迁移标识。",
            false,
            "stage=resolve_git_identity; encoding=non_utf8",
        ));
        return None;
    };
    let Some(repository_relative_path) = identity.repository_relative_path.to_str() else {
        diagnostics.push(Diagnostic::new(
            "git_identity_not_utf8",
            "Git 仓库相对路径无法安全表示。",
            "项目仍会添加，但不会保存 Git 迁移标识。",
            false,
            "stage=resolve_git_identity; encoding=non_utf8",
        ));
        return None;
    };
    Some(ProjectGitIdentity {
        common_directory: common_directory.to_owned(),
        repository_relative_path: repository_relative_path.to_owned(),
    })
}

fn validate_binding_input(
    profile: &str,
    terminal_mode: TerminalMode,
    account_policy: AccountPolicy,
) -> Result<(), DomainError> {
    if !is_valid_profile(profile) {
        return Err(project_error(
            "project_profile_invalid",
            "OMP Profile 名称无效。",
            "使用 default 或小写字母/数字开头、最长 64 字符的已确认 Profile 名。",
            false,
            "stage=validate_binding; profile=invalid",
        ));
    }
    if terminal_mode != TerminalMode::Embedded {
        return Err(project_error(
            "project_terminal_mode_unavailable",
            "当前里程碑仅支持内嵌终端。",
            "请选择内嵌终端；外部终端将在后续里程碑开放。",
            false,
            "stage=validate_binding; terminal_mode=external",
        ));
    }
    if account_policy == AccountPolicy::CredentialPin {
        return Err(project_error(
            "project_credential_pin_unavailable",
            "当前 OMP 能力证据不支持固定具体凭证。",
            "使用自动账号策略或 Profile 账号集合。",
            false,
            "stage=validate_binding; account_policy=credential_pin",
        ));
    }
    Ok(())
}

fn validate_project_id(value: i64) -> Result<(), DomainError> {
    if (1..=MAXIMUM_SAFE_JS_INTEGER).contains(&value) {
        return Ok(());
    }
    Err(project_error(
        "project_id_invalid",
        "项目标识无效。",
        "刷新项目列表后重试。",
        false,
        "stage=validate_project_id; value=out_of_range",
    ))
}

fn validate_path_text(value: &str, field: &str) -> Result<(), DomainError> {
    validate_bounded_text(value, field, MAXIMUM_PATH_BYTES)
}

fn validate_bounded_text(
    value: &str,
    field: &str,
    maximum_bytes: usize,
) -> Result<(), DomainError> {
    if !value.is_empty() && value.len() <= maximum_bytes && !value.contains('\0') {
        return Ok(());
    }
    Err(project_data_error(field, "invalid_text"))
}

fn required_text(
    value: Option<String>,
    field: &str,
    maximum_bytes: usize,
) -> Result<String, DomainError> {
    let value = value.ok_or_else(|| project_data_error(field, "missing"))?;
    validate_bounded_text(&value, field, maximum_bytes)?;
    Ok(value)
}

fn path_to_text(path: &Path, field: &str) -> Result<String, DomainError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        project_error(
            "project_path_not_utf8",
            "所选项目路径无法安全表示。",
            "当前版本仅支持可表示为 Unicode 的项目路径。",
            false,
            &format!("stage=encode_project_path; field={field}"),
        )
    })
}

fn canonical_path_key(canonical_path: &str) -> String {
    canonical_path.to_owned()
}

fn terminal_mode_text(value: TerminalMode) -> &'static str {
    match value {
        TerminalMode::Embedded => "embedded",
        TerminalMode::External => "external",
    }
}

fn parse_terminal_mode(value: String) -> Result<TerminalMode, DomainError> {
    match value.as_str() {
        "embedded" => Ok(TerminalMode::Embedded),
        "external" => Ok(TerminalMode::External),
        _ => Err(project_data_error("terminal_mode", "unknown")),
    }
}

fn account_policy_text(value: AccountPolicy) -> &'static str {
    match value {
        AccountPolicy::Automatic => "automatic",
        AccountPolicy::Profile => "profile",
        AccountPolicy::CredentialPin => "credential_pin",
    }
}

fn parse_account_policy(value: String) -> Result<AccountPolicy, DomainError> {
    match value.as_str() {
        "automatic" => Ok(AccountPolicy::Automatic),
        "profile" => Ok(AccountPolicy::Profile),
        "credential_pin" => Ok(AccountPolicy::CredentialPin),
        _ => Err(project_data_error("account_policy", "unknown")),
    }
}

fn parse_authorization_status(
    value: Option<String>,
) -> Result<ProjectAuthorizationStatus, DomainError> {
    match value.as_deref() {
        None => Ok(ProjectAuthorizationStatus::Missing),
        Some("active") => Ok(ProjectAuthorizationStatus::Active),
        Some("offline") => Ok(ProjectAuthorizationStatus::Offline),
        Some("replaced") => Ok(ProjectAuthorizationStatus::Replaced),
        Some("revoked") => Ok(ProjectAuthorizationStatus::Revoked),
        Some(_) => Err(project_data_error("authorization_status", "unknown")),
    }
}

fn authorization_status_text(
    value: ProjectAuthorizationStatus,
) -> Result<&'static str, DomainError> {
    match value {
        ProjectAuthorizationStatus::Active => Ok("active"),
        ProjectAuthorizationStatus::Offline => Ok("offline"),
        ProjectAuthorizationStatus::Replaced => Ok("replaced"),
        ProjectAuthorizationStatus::Revoked => Ok("revoked"),
        ProjectAuthorizationStatus::Missing => Err(project_error(
            "project_authorization_status_invalid",
            "不能把缺失授权写入已有授权记录。",
            "刷新项目列表并重新授权目录。",
            false,
            "stage=authorization_status; value=missing",
        )),
    }
}

fn nonnegative_u64(value: i64, field: &str) -> Result<u64, DomainError> {
    u64::try_from(value).map_err(|_| project_data_error(field, "negative"))
}

fn positive_u64(value: i64, field: &str) -> Result<u64, DomainError> {
    let value = nonnegative_u64(value, field)?;
    if value > 0 {
        Ok(value)
    } else {
        Err(project_data_error(field, "not_positive"))
    }
}

fn epoch_millis_i64() -> Result<i64, DomainError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(millis).map_err(|_| {
        project_error(
            "project_clock_out_of_range",
            "系统时间超出项目数据库支持范围。",
            "校正系统时间后重试。",
            false,
            "stage=project_clock; value=out_of_range",
        )
    })
}

async fn spawn_database_task<T: Send + 'static>(
    stage: &'static str,
    operation: impl FnOnce() -> Result<T, DomainError> + Send + 'static,
) -> Result<T, DomainError> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            project_error(
                "project_database_task_failed",
                "项目数据库任务异常结束。",
                "刷新项目列表后重试；若问题持续，请重新启动应用。",
                true,
                &format!("stage={stage}; join_error={}", redact(&error.to_string())),
            )
        })?
}

fn project_database_error(stage: &str, error: &rusqlite::Error) -> DomainError {
    project_error(
        "project_database_failed",
        "无法更新 OMP Manager 项目数据。",
        "确认元数据数据库可用后重试。",
        true,
        &format!("stage={stage}; sqlite={}", redact(&error.to_string())),
    )
}

fn project_data_error(field: &str, reason: &str) -> DomainError {
    project_error(
        "project_database_inconsistent",
        "项目数据库包含无法识别的记录。",
        "保留数据库并检查迁移状态；不要继续修改该记录。",
        false,
        &format!("stage=decode_project; field={field}; reason={reason}"),
    )
}

fn project_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    detail: &str,
) -> DomainError {
    DomainError::new(code, message, suggestion, retryable, redact(detail))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;
    use tempfile::tempdir;

    use super::*;
    use crate::adapters::editors::{EditorLaunch, VerifiedEditor};
    use crate::adapters::targets::LocalTarget;

    #[derive(Default)]
    struct FakeEditor {
        probe_count: AtomicUsize,
        opened_paths: Mutex<Vec<PathBuf>>,
        open_delay: std::time::Duration,
    }

    #[async_trait]
    impl ExternalEditorAdapter for FakeEditor {
        fn editor_id(&self) -> &'static str {
            "cursor"
        }

        async fn probe(&self) -> Result<VerifiedEditor, DomainError> {
            self.probe_count.fetch_add(1, Ordering::SeqCst);
            Ok(VerifiedEditor::synthetic())
        }

        async fn open_directory(
            &self,
            _editor: &VerifiedEditor,
            directory: &Path,
            _expected_directory_identity_json: &str,
        ) -> Result<EditorLaunch, DomainError> {
            tokio::time::sleep(self.open_delay).await;
            self.opened_paths
                .lock()
                .expect("opened paths")
                .push(directory.to_owned());
            Ok(EditorLaunch {
                process_id: Some(42),
            })
        }
    }

    struct FinalBoundaryRejectingEditor {
        code: &'static str,
    }

    #[async_trait]
    impl ExternalEditorAdapter for FinalBoundaryRejectingEditor {
        fn editor_id(&self) -> &'static str {
            "cursor"
        }

        async fn probe(&self) -> Result<VerifiedEditor, DomainError> {
            Ok(VerifiedEditor::synthetic())
        }

        async fn open_directory(
            &self,
            _editor: &VerifiedEditor,
            _directory: &Path,
            _expected_directory_identity_json: &str,
        ) -> Result<EditorLaunch, DomainError> {
            Err(DomainError::new(
                self.code,
                "最终边界拒绝项目路径。",
                "重新验证项目。",
                false,
                "stage=test_final_boundary",
            ))
        }
    }

    fn service(database_directory: &Path) -> ProjectService {
        let runtime = DatabaseRuntime::pending(database_directory.to_owned());
        let report = runtime
            .run_initialization()
            .expect("database initialization");
        assert_eq!(report.schema_version, Some(9));
        ProjectService::new(runtime, Arc::new(LocalTarget::default()))
    }

    fn service_with_editor(database_directory: &Path) -> (ProjectService, Arc<FakeEditor>) {
        service_with_editor_delay(database_directory, std::time::Duration::ZERO)
    }

    fn service_with_editor_delay(
        database_directory: &Path,
        open_delay: std::time::Duration,
    ) -> (ProjectService, Arc<FakeEditor>) {
        let runtime = DatabaseRuntime::pending(database_directory.to_owned());
        runtime
            .run_initialization()
            .expect("database initialization");
        let editor = Arc::new(FakeEditor {
            open_delay,
            ..FakeEditor::default()
        });
        (
            ProjectService::with_editor(runtime, Arc::new(LocalTarget::default()), editor.clone()),
            editor,
        )
    }

    fn add_request(profile: &str) -> AddProjectRequest {
        AddProjectRequest {
            profile: profile.to_owned(),
            terminal_mode: TerminalMode::Embedded,
            account_policy: AccountPolicy::Automatic,
        }
    }

    #[tokio::test]
    async fn adds_an_authorized_project_atomically_and_keeps_duplicate_binding() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        let project_path = project_directory
            .path()
            .join("项目 & 'quoted'; folder\nline");
        fs::create_dir(&project_path).expect("dangerous project directory");
        let service = service(database_directory.path());

        let first = service
            .add_project(project_path.clone(), add_request("work.profile"))
            .await
            .expect("first add");
        assert_eq!(first.project.binding.profile, "work.profile");
        assert_eq!(
            first.project.authorization_status,
            ProjectAuthorizationStatus::Active
        );
        assert!(first.diagnostics.is_empty());

        let second = service
            .add_project(project_path.clone(), add_request("other"))
            .await
            .expect("duplicate add");
        assert_eq!(second.project.id, first.project.id);
        assert_eq!(second.project.binding.profile, "work.profile");
        assert_eq!(second.diagnostics[0].code, "project_already_registered");

        let workspace = service.workspace().await.expect("workspace");
        assert_eq!(workspace.projects.len(), 1);
        assert_eq!(workspace.known_profiles.len(), 2);
        assert!(workspace
            .known_profiles
            .iter()
            .all(|profile| !profile.is_complete_inventory));
    }

    #[tokio::test]
    async fn resolves_nested_bindings_by_path_components_and_updates_with_cas() {
        let database_directory = tempdir().expect("database directory");
        let root = tempdir().expect("project root");
        let parent = root.path().join("app");
        let child = parent.join("nested");
        let sibling = root.path().join("application");
        fs::create_dir_all(&child).expect("nested project");
        fs::create_dir(&sibling).expect("similar sibling");
        let service = service(database_directory.path());
        let parent_project = service
            .add_project(parent.clone(), add_request("parent"))
            .await
            .expect("parent add")
            .project;
        let child_project = service
            .add_project(child.clone(), add_request("child"))
            .await
            .expect("child add")
            .project;

        let resolved = service
            .resolve_binding_for_path(&child)
            .await
            .expect("resolve child")
            .expect("child binding");
        assert_eq!(resolved.profile, "child");
        assert!(service
            .resolve_binding_for_path(&sibling)
            .await
            .expect("resolve sibling")
            .is_none());

        let updated = service
            .update_binding(UpdateProjectBindingRequest {
                project_id: parent_project.id,
                expected_revision: parent_project.binding.revision,
                profile: "updated".to_owned(),
                terminal_mode: TerminalMode::Embedded,
                account_policy: AccountPolicy::Profile,
            })
            .await
            .expect("update binding");
        assert_eq!(
            updated.binding.revision,
            parent_project.binding.revision + 1
        );
        assert_eq!(updated.binding.profile, "updated");
        let conflict = service
            .update_binding(UpdateProjectBindingRequest {
                project_id: parent_project.id,
                expected_revision: parent_project.binding.revision,
                profile: "stale".to_owned(),
                terminal_mode: TerminalMode::Embedded,
                account_policy: AccountPolicy::Automatic,
            })
            .await
            .expect_err("stale update rejected");
        assert_eq!(conflict.code, "project_binding_conflict");
        assert_eq!(child_project.binding.profile, "child");
    }

    #[tokio::test]
    async fn rejects_capabilities_that_m1_does_not_support() {
        let database_directory = tempdir().expect("database directory");
        let service = service(database_directory.path());
        let invalid_pin = service
            .add_project(
                database_directory.path().to_owned(),
                AddProjectRequest {
                    profile: "default".to_owned(),
                    terminal_mode: TerminalMode::Embedded,
                    account_policy: AccountPolicy::CredentialPin,
                },
            )
            .await
            .expect_err("credential pin rejected");
        assert_eq!(invalid_pin.code, "project_credential_pin_unavailable");

        let external = service
            .add_project(
                database_directory.path().to_owned(),
                AddProjectRequest {
                    profile: "default".to_owned(),
                    terminal_mode: TerminalMode::External,
                    account_policy: AccountPolicy::Automatic,
                },
            )
            .await
            .expect_err("external terminal rejected");
        assert_eq!(external.code, "project_terminal_mode_unavailable");
    }

    #[tokio::test]
    async fn rolls_back_project_and_root_when_the_binding_write_fails() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        let service = service(database_directory.path());
        let database = service.database.database().expect("ready database");
        database
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "CREATE TRIGGER test_reject_project_binding
                         BEFORE INSERT ON project_bindings
                         BEGIN
                           SELECT RAISE(ABORT, 'synthetic binding failure');
                         END;",
                    )
                    .map_err(|error| project_database_error("install_test_trigger", &error))?;
                Ok(())
            })
            .expect("install failure trigger");

        let error = service
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect_err("binding failure rolls back add");
        assert_eq!(error.code, "project_database_failed");
        let counts = database
            .with_connection(|connection| {
                let projects: i64 = connection
                    .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
                    .map_err(|error| project_database_error("count_projects", &error))?;
                let roots: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM authorized_roots WHERE kind = 'project'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| project_database_error("count_roots", &error))?;
                Ok((projects, roots))
            })
            .expect("transaction counts");
        assert_eq!(counts, (0, 0));
    }

    #[tokio::test]
    async fn reports_optional_git_failure_without_blocking_project_registration() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        fs::write(project_directory.path().join(".git"), "not a git pointer")
            .expect("malformed git marker");
        let service = service(database_directory.path());

        let result = service
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("project add remains available");
        assert!(result.project.git_identity.is_none());
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "git_identity_invalid");
        assert_eq!(
            service.workspace().await.expect("workspace").projects.len(),
            1
        );
    }

    #[tokio::test]
    async fn exposes_a_legacy_project_without_an_authorized_root_as_missing() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        let service = service(database_directory.path());
        let canonical = fs::canonicalize(project_directory.path()).expect("canonical project");
        let canonical = canonical.to_str().expect("utf8 project").to_owned();
        let database = service.database.database().expect("ready database");
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO projects (
                            target_id, canonical_path, canonical_key, display_path,
                            created_at_epoch_ms, last_used_at_epoch_ms
                         ) VALUES ('local', ?1, ?1, ?1, 1, 1)",
                        [&canonical],
                    )
                    .map_err(|error| project_database_error("insert_legacy_project", &error))?;
                let project_id = connection.last_insert_rowid();
                connection
                    .execute(
                        "INSERT INTO project_bindings (
                            target_id, project_id, path_prefix, path_prefix_key, profile,
                            terminal_mode, account_policy, updated_at_epoch_ms, revision
                         ) VALUES ('local', ?1, ?2, ?2, 'default', 'embedded',
                                   'automatic', 1, 1)",
                        params![project_id, canonical],
                    )
                    .map_err(|error| project_database_error("insert_legacy_binding", &error))?;
                Ok(())
            })
            .expect("insert legacy project");

        let workspace = service.workspace().await.expect("legacy workspace");
        assert_eq!(workspace.projects.len(), 1);
        assert_eq!(
            workspace.projects[0].authorization_status,
            ProjectAuthorizationStatus::Missing
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn opens_only_the_revalidated_authorized_path_in_the_fixed_editor() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        let project_path = project_directory.path().join("项目 & ';$() folder\nline");
        fs::create_dir(&project_path).expect("project path");
        let canonical_path = fs::canonicalize(&project_path).expect("canonical project");
        let (service, editor) = service_with_editor(database_directory.path());
        let project = service
            .add_project(project_path, add_request("default"))
            .await
            .expect("add project")
            .project;

        let result = service
            .open_in_editor(OpenProjectInEditorRequest {
                project_id: project.id,
                editor_id: ExternalEditorId::Cursor,
            })
            .await
            .expect("open project");

        assert_eq!(result.project_id, project.id);
        assert_eq!(result.editor_id, ExternalEditorId::Cursor);
        assert_eq!(result.process_id, Some(42));
        assert_eq!(editor.probe_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            editor.opened_paths.lock().expect("opened paths").as_slice(),
            [canonical_path]
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn rejects_concurrent_editor_launches_for_the_same_project() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        let (service, editor) = service_with_editor_delay(
            database_directory.path(),
            std::time::Duration::from_millis(100),
        );
        let project = service
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("add project")
            .project;
        let request = OpenProjectInEditorRequest {
            project_id: project.id,
            editor_id: ExternalEditorId::Cursor,
        };
        let first_service = service.clone();
        let first_request = request.clone();
        let first = tokio::spawn(async move { first_service.open_in_editor(first_request).await });
        for _ in 0..100 {
            if editor.probe_count.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        assert_eq!(editor.probe_count.load(Ordering::SeqCst), 1);

        let error = service
            .open_in_editor(request)
            .await
            .expect_err("concurrent open rejected");
        assert_eq!(error.code, "project_editor_open_in_progress");
        first
            .await
            .expect("first launch task")
            .expect("first launch succeeds");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn records_a_final_boundary_path_replacement() {
        let database_directory = tempdir().expect("database directory");
        let project_directory = tempdir().expect("project directory");
        let runtime = DatabaseRuntime::pending(database_directory.path().to_owned());
        runtime
            .run_initialization()
            .expect("database initialization");
        let service = ProjectService::with_editor(
            runtime,
            Arc::new(LocalTarget::default()),
            Arc::new(FinalBoundaryRejectingEditor {
                code: "cursor_project_identity_changed",
            }),
        );
        let project = service
            .add_project(project_directory.path().to_owned(), add_request("default"))
            .await
            .expect("add project")
            .project;

        let error = service
            .open_in_editor(OpenProjectInEditorRequest {
                project_id: project.id,
                editor_id: ExternalEditorId::Cursor,
            })
            .await
            .expect_err("final replacement rejected");
        assert_eq!(error.code, "cursor_project_identity_changed");
        let workspace = service.workspace().await.expect("workspace");
        assert_eq!(
            workspace.projects[0].authorization_status,
            ProjectAuthorizationStatus::Replaced
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn marks_missing_and_replaced_project_roots_before_editor_probe() {
        let database_directory = tempdir().expect("database directory");
        let root = tempdir().expect("project root");
        let offline_path = root.path().join("offline");
        let replaced_path = root.path().join("replaced");
        fs::create_dir(&offline_path).expect("offline project");
        fs::create_dir(&replaced_path).expect("replaced project");
        let (service, editor) = service_with_editor(database_directory.path());
        let offline = service
            .add_project(offline_path.clone(), add_request("default"))
            .await
            .expect("add offline project")
            .project;
        let replaced = service
            .add_project(replaced_path.clone(), add_request("default"))
            .await
            .expect("add replaced project")
            .project;

        fs::remove_dir(&offline_path).expect("remove offline project");
        fs::rename(&replaced_path, root.path().join("replaced-original"))
            .expect("move original project");
        fs::create_dir(&replaced_path).expect("replace project directory");

        let offline_error = service
            .open_in_editor(OpenProjectInEditorRequest {
                project_id: offline.id,
                editor_id: ExternalEditorId::Cursor,
            })
            .await
            .expect_err("offline path rejected");
        let replaced_error = service
            .open_in_editor(OpenProjectInEditorRequest {
                project_id: replaced.id,
                editor_id: ExternalEditorId::Cursor,
            })
            .await
            .expect_err("replaced path rejected");
        assert_eq!(offline_error.code, "project_authorization_offline");
        assert_eq!(replaced_error.code, "project_authorization_replaced");
        assert_eq!(editor.probe_count.load(Ordering::SeqCst), 0);

        let workspace = service.workspace().await.expect("workspace");
        assert_eq!(
            workspace
                .projects
                .iter()
                .find(|project| project.id == offline.id)
                .map(|project| project.authorization_status),
            Some(ProjectAuthorizationStatus::Offline)
        );
        assert_eq!(
            workspace
                .projects
                .iter()
                .find(|project| project.id == replaced.id)
                .map(|project| project.authorization_status),
            Some(ProjectAuthorizationStatus::Replaced)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn canonicalizes_a_symlink_alias_to_the_same_project_identity() {
        use std::os::unix::fs::symlink;

        let database_directory = tempdir().expect("database directory");
        let root = tempdir().expect("project root");
        let project = root.path().join("real-project");
        let alias = root.path().join("project-alias");
        fs::create_dir(&project).expect("real project");
        symlink(&project, &alias).expect("project symlink");
        let service = service(database_directory.path());

        let first = service
            .add_project(project, add_request("default"))
            .await
            .expect("real project add");
        let second = service
            .add_project(alias, add_request("other"))
            .await
            .expect("alias add");
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(second.project.binding.profile, "default");
        assert_eq!(
            service.workspace().await.expect("workspace").projects.len(),
            1
        );
    }
}
