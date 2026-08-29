use std::path::PathBuf;

use crate::adapters::targets::{ExecutionTarget, LocalTarget};
use crate::domain::{
    AddProjectRequest, AddProjectResult, DatabaseAvailability, DatabaseStatusReport, DomainError,
    OmpProbeOperationSnapshot, OpenProjectInEditorRequest, OpenProjectInEditorResult,
    OperationSnapshot, ProjectSessionPreview, ProjectSessionPreviewRequest,
    ProjectSessionsSnapshot, ProjectSummary, ProjectWorkspaceSnapshot, PtySpikeReport,
    UpdateProjectBindingRequest,
};
use crate::infrastructure::db::DatabaseRuntime;
use crate::infrastructure::secrets::redact;
use crate::services::{ProjectService, SessionService, TaskSupervisor};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn database_status(
    runtime: tauri::State<'_, DatabaseRuntime>,
) -> Result<DatabaseStatusReport, DomainError> {
    runtime.snapshot()
}

#[tauri::command]
pub async fn retry_database_initialization(
    runtime: tauri::State<'_, DatabaseRuntime>,
    supervisor: tauri::State<'_, TaskSupervisor>,
) -> Result<DatabaseStatusReport, DomainError> {
    let runtime = runtime.inner().clone();
    let supervisor = supervisor.inner().clone();
    let worker_runtime = runtime.clone();
    match tokio::task::spawn_blocking(move || worker_runtime.run_initialization()).await {
        Ok(Ok(report)) => {
            if report.availability == DatabaseAvailability::Ready {
                drop(tokio::task::spawn_blocking(move || {
                    supervisor.reconcile_history()
                }));
            }
            Ok(report)
        }
        Ok(Err(error)) => Err(error),
        Err(_) => {
            runtime.mark_initialization_worker_failed()?;
            Err(DomainError::new(
                "database_retry_task_failed",
                "数据库恢复重试任务异常结束。",
                "重新启动应用后再试；若问题持续，请保留数据库与备份。",
                true,
                "stage=retry_database_initialization; task=join_failed",
            ))
        }
    }
}

#[tauri::command]
pub async fn start_omp_probe(
    requested_path: Option<String>,
    supervisor: tauri::State<'_, TaskSupervisor>,
) -> Result<OmpProbeOperationSnapshot, DomainError> {
    supervisor.start_omp_probe(requested_path.map(PathBuf::from))
}

#[tauri::command]
pub async fn project_workspace(
    projects: tauri::State<'_, ProjectService>,
) -> Result<ProjectWorkspaceSnapshot, DomainError> {
    projects.workspace().await
}

#[tauri::command]
pub async fn project_sessions(
    project_id: i64,
    sessions: tauri::State<'_, SessionService>,
) -> Result<ProjectSessionsSnapshot, DomainError> {
    sessions.snapshot(project_id).await
}

#[tauri::command]
pub async fn preview_project_session(
    request: ProjectSessionPreviewRequest,
    sessions: tauri::State<'_, SessionService>,
) -> Result<ProjectSessionPreview, DomainError> {
    sessions.preview(request).await
}

#[tauri::command]
pub async fn scan_project_sessions(
    project_id: i64,
    sessions: tauri::State<'_, SessionService>,
) -> Result<ProjectSessionsSnapshot, DomainError> {
    sessions.scan(project_id).await
}

#[tauri::command]
pub async fn authorize_project_sessions(
    project_id: i64,
    app: tauri::AppHandle,
    sessions: tauri::State<'_, SessionService>,
) -> Result<Option<ProjectSessionsSnapshot>, DomainError> {
    sessions.ensure_available()?;
    let intent = sessions.prepare_root_authorization(project_id).await?;
    let selected = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|_| {
            DomainError::new(
                "session_root_picker_task_failed",
                "会话根目录选择任务异常结束。",
                "重新选择 OMP sessions 目录；若问题持续，请重新启动应用。",
                true,
                "stage=session_root_picker; task=join_failed",
            )
        })?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(|_| {
        DomainError::new(
            "session_root_picker_path_invalid",
            "系统目录选择器没有返回本地路径。",
            "请选择本机文件系统中的 OMP sessions 目录。",
            false,
            "stage=session_root_picker; path_kind=non_local",
        )
    })?;
    sessions
        .authorize_and_scan_intent(intent, selected)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn add_project(
    request: AddProjectRequest,
    app: tauri::AppHandle,
    projects: tauri::State<'_, ProjectService>,
) -> Result<Option<AddProjectResult>, DomainError> {
    let selected = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|error| {
            DomainError::new(
                "project_picker_task_failed",
                "系统目录选择任务异常结束。",
                "重新选择项目目录；若问题持续，请重新启动应用。",
                true,
                redact(&format!("stage=project_picker; join_error={error}")),
            )
        })?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(|error| {
        DomainError::new(
            "project_picker_path_invalid",
            "系统目录选择器没有返回本地路径。",
            "请选择本机文件系统中的目录，不要选择 URI 或远程文档。",
            false,
            redact(&format!(
                "stage=project_picker; path_kind=non_local; error={error}"
            )),
        )
    })?;
    projects.add_project(selected, request).await.map(Some)
}

#[tauri::command]
pub async fn update_project_binding(
    request: UpdateProjectBindingRequest,
    projects: tauri::State<'_, ProjectService>,
) -> Result<ProjectSummary, DomainError> {
    projects.update_binding(request).await
}

#[tauri::command]
pub async fn open_project_in_editor(
    request: OpenProjectInEditorRequest,
    projects: tauri::State<'_, ProjectService>,
) -> Result<OpenProjectInEditorResult, DomainError> {
    projects.open_in_editor(request).await
}

#[tauri::command]
pub async fn get_omp_probe_operation(
    operation_id: String,
    supervisor: tauri::State<'_, TaskSupervisor>,
) -> Result<OmpProbeOperationSnapshot, DomainError> {
    supervisor.get_omp_probe(&operation_id)
}

#[tauri::command]
pub fn cancel_operation(
    operation_id: String,
    supervisor: tauri::State<'_, TaskSupervisor>,
) -> Result<OperationSnapshot, DomainError> {
    supervisor.cancel_operation(&operation_id)
}

#[tauri::command]
pub async fn pty_spike() -> Result<PtySpikeReport, DomainError> {
    LocalTarget::default().spawn_pty().await
}
