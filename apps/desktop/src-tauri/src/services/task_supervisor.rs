use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use uuid::Uuid;

use crate::adapters::omp::OmpAdapter;
use crate::domain::{
    Diagnostic, DomainError, OmpProbeOperationSnapshot, OperationKind, OperationSnapshot,
    OperationStatus, ProbeReport,
};
use crate::infrastructure::db::DatabaseRuntime;

const TARGET_ID: &str = "local";
const PROBE_SCOPE_KIND: &str = "omp_installation";
const PERSISTENCE_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct TaskPolicy {
    pub omp_probe_timeout: Duration,
    pub maximum_retained_operations: usize,
}

impl Default for TaskPolicy {
    fn default() -> Self {
        Self {
            omp_probe_timeout: Duration::from_secs(40),
            maximum_retained_operations: 128,
        }
    }
}

#[derive(Clone)]
pub struct TaskSupervisor {
    inner: Arc<Mutex<SupervisorInner>>,
    reconciliation: Arc<Mutex<bool>>,
    database: DatabaseRuntime,
    omp_adapter: Arc<dyn OmpAdapter>,
    policy: TaskPolicy,
}

struct SupervisorInner {
    operations: HashMap<String, OmpProbeOperationSnapshot>,
    operation_order: VecDeque<String>,
    active_probe: Option<String>,
    persistence_in_progress: HashSet<String>,
    persistence_retry_after: HashMap<String, Instant>,
}

#[derive(Debug, Clone)]
struct ProbeScope {
    requested_path: Option<PathBuf>,
}

impl fmt::Debug for TaskSupervisor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let operation_count = self.inner.lock().map(|inner| inner.operations.len()).ok();
        formatter
            .debug_struct("TaskSupervisor")
            .field("operation_count", &operation_count)
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl TaskSupervisor {
    pub fn new(
        database: DatabaseRuntime,
        omp_adapter: Arc<dyn OmpAdapter>,
        policy: TaskPolicy,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(SupervisorInner {
                operations: HashMap::new(),
                operation_order: VecDeque::new(),
                active_probe: None,
                persistence_in_progress: HashSet::new(),
                persistence_retry_after: HashMap::new(),
            })),
            reconciliation: Arc::new(Mutex::new(false)),
            database,
            omp_adapter,
            policy,
        }
    }

    pub fn start_omp_probe(
        &self,
        requested_path: Option<PathBuf>,
    ) -> Result<OmpProbeOperationSnapshot, DomainError> {
        validate_requested_executable(requested_path.as_deref())?;
        let scope = ProbeScope { requested_path };

        let (operation_id, snapshot) = {
            let mut inner = self.lock()?;
            if let Some(operation_id) = inner.active_probe.clone() {
                return inner.operations.get(&operation_id).cloned().ok_or_else(|| {
                    DomainError::new(
                        "operation_registry_inconsistent",
                        "后台任务注册表状态不一致。",
                        "重新启动应用后重试。",
                        false,
                        "stage=start_omp_probe; active_operation=missing",
                    )
                });
            }

            prune_terminal_operations(&mut inner, self.policy.maximum_retained_operations)?;
            let operation_id = Uuid::new_v4().to_string();
            let now = epoch_millis();
            let snapshot = OmpProbeOperationSnapshot {
                operation: OperationSnapshot {
                    operation_id: operation_id.clone(),
                    kind: OperationKind::OmpProbe,
                    target_id: TARGET_ID.to_owned(),
                    scope_kind: PROBE_SCOPE_KIND.to_owned(),
                    scope_reference: scope_reference(&scope),
                    phase: "queued".to_owned(),
                    status: OperationStatus::Queued,
                    revision: 1,
                    cancellable: false,
                    cancellation_requested: false,
                    started_at_epoch_ms: now,
                    updated_at_epoch_ms: now,
                    finished_at_epoch_ms: None,
                    history_persisted: false,
                    persistence_diagnostic: None,
                },
                result: None,
                diagnostic: None,
            };
            inner.active_probe = Some(operation_id.clone());
            inner.operation_order.push_back(operation_id.clone());
            inner
                .operations
                .insert(operation_id.clone(), snapshot.clone());
            (operation_id, snapshot)
        };

        self.spawn_probe_worker(operation_id, scope);
        Ok(snapshot)
    }

    pub fn get_omp_probe(
        &self,
        operation_id: &str,
    ) -> Result<OmpProbeOperationSnapshot, DomainError> {
        validate_operation_id(operation_id)?;
        let snapshot = self
            .lock()?
            .operations
            .get(operation_id)
            .cloned()
            .ok_or_else(operation_not_found)?;
        if !snapshot.operation.history_persisted
            && snapshot
                .operation
                .persistence_diagnostic
                .as_ref()
                .is_none_or(|diagnostic| diagnostic.retryable)
        {
            self.schedule_persistence(operation_id)?;
        }
        Ok(snapshot)
    }

    pub fn cancel_operation(&self, operation_id: &str) -> Result<OperationSnapshot, DomainError> {
        validate_operation_id(operation_id)?;
        let inner = self.lock()?;
        let operation = &inner
            .operations
            .get(operation_id)
            .ok_or_else(operation_not_found)?
            .operation;
        if operation.status.is_terminal() {
            return Ok(operation.clone());
        }
        if !operation.cancellable {
            return Err(DomainError::new(
                "operation_not_cancellable",
                "当前后台任务不支持可靠取消。",
                "等待任务完成；其子进程仍受固定超时和输出上限保护。",
                false,
                format!("operation_kind={}", operation.kind.as_str()),
            ));
        }

        Err(DomainError::new(
            "operation_cancel_not_implemented",
            "当前任务类型尚未实现取消信号。",
            "等待任务完成。",
            false,
            format!("operation_kind={}", operation.kind.as_str()),
        ))
    }

    pub fn reconcile_history(&self) -> Result<(), DomainError> {
        let mut reconciled = self.reconciliation.lock().map_err(|_| {
            DomainError::new(
                "operation_reconciliation_state_poisoned",
                "后台任务对账状态不可用。",
                "重新启动应用后重试。",
                false,
                "stage=reconcile_history; mutex=poisoned",
            )
        })?;
        if *reconciled {
            return Ok(());
        }

        let database = self.database.database()?;
        let now = epoch_millis_i64()?;
        database.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE operation_history
                     SET phase = 'startup_reconcile',
                         status = 'needs_reconciliation',
                         revision = revision + 1,
                         updated_at_epoch_ms = ?1,
                         finished_at_epoch_ms = COALESCE(finished_at_epoch_ms, ?1),
                         redacted_result_json = '{\"outcome\":\"interrupted\"}'
                     WHERE status IN ('queued', 'running', 'cancelling')",
                    [now],
                )
                .map_err(|error| operation_history_error("reconcile", &error))?;
            Ok(())
        })?;
        *reconciled = true;
        Ok(())
    }

    fn spawn_probe_worker(&self, operation_id: String, scope: ProbeScope) {
        let worker = self.clone();
        let worker_operation_id = operation_id.clone();
        let handle = tokio::spawn(async move {
            worker.run_probe(worker_operation_id.as_str(), scope).await;
        });
        let monitor = self.clone();
        tokio::spawn(async move {
            if handle.await.is_err() {
                monitor.finish_probe(
                    &operation_id,
                    OperationStatus::Failed,
                    None,
                    Some(Diagnostic::new(
                        "omp_probe_task_failed",
                        "OMP 探测后台任务异常结束。",
                        "重新检测；若问题持续，请检查 OMP 安装。",
                        true,
                        "stage=omp_probe_worker; task=join_failed",
                    )),
                );
                let _ = monitor.schedule_persistence(&operation_id);
            }
        });
    }

    async fn run_probe(&self, operation_id: &str, scope: ProbeScope) {
        if self.mark_running(operation_id).is_err() {
            return;
        }
        let _ = self.schedule_persistence(operation_id);

        let probe = self
            .omp_adapter
            .probe_capabilities(scope.requested_path.as_deref());
        match tokio::time::timeout(self.policy.omp_probe_timeout, probe).await {
            Ok(Ok(report)) => {
                self.finish_probe(operation_id, OperationStatus::Succeeded, Some(report), None);
            }
            Ok(Err(error)) => {
                self.finish_probe(
                    operation_id,
                    OperationStatus::Failed,
                    None,
                    Some(error.into()),
                );
            }
            Err(_) => {
                self.finish_probe(
                    operation_id,
                    OperationStatus::TimedOut,
                    None,
                    Some(Diagnostic::new(
                        "omp_probe_operation_timeout",
                        "OMP 探测任务超过总时间限制。",
                        "检查 OMP 安装状态后重新检测。",
                        true,
                        format!(
                            "stage=omp_probe; timeout_ms={}",
                            self.policy.omp_probe_timeout.as_millis()
                        ),
                    )),
                );
            }
        }
        let _ = self.schedule_persistence(operation_id);
    }

    fn mark_running(&self, operation_id: &str) -> Result<(), DomainError> {
        let mut inner = self.lock()?;
        let snapshot = inner
            .operations
            .get_mut(operation_id)
            .ok_or_else(operation_not_found)?;
        let now = epoch_millis();
        snapshot.operation.status = OperationStatus::Running;
        snapshot.operation.phase = "probing".to_owned();
        snapshot.operation.revision = next_revision(snapshot.operation.revision);
        snapshot.operation.updated_at_epoch_ms = now;
        snapshot.operation.history_persisted = false;
        snapshot.operation.persistence_diagnostic = None;
        Ok(())
    }

    fn finish_probe(
        &self,
        operation_id: &str,
        status: OperationStatus,
        result: Option<ProbeReport>,
        diagnostic: Option<Diagnostic>,
    ) {
        let Ok(mut inner) = self.lock() else {
            return;
        };
        if inner.active_probe.as_deref() == Some(operation_id) {
            inner.active_probe = None;
        }
        let Some(snapshot) = inner.operations.get_mut(operation_id) else {
            return;
        };
        let now = epoch_millis();
        snapshot.operation.status = status;
        snapshot.operation.phase = match status {
            OperationStatus::Succeeded => "completed",
            OperationStatus::TimedOut => "timed_out",
            OperationStatus::Cancelled => "cancelled",
            _ => "failed",
        }
        .to_owned();
        snapshot.operation.revision = next_revision(snapshot.operation.revision);
        snapshot.operation.updated_at_epoch_ms = now;
        snapshot.operation.finished_at_epoch_ms = Some(now);
        snapshot.operation.history_persisted = false;
        snapshot.operation.persistence_diagnostic = None;
        snapshot.result = result;
        snapshot.diagnostic = diagnostic;
    }

    fn schedule_persistence(&self, operation_id: &str) -> Result<(), DomainError> {
        let (snapshot, expected_revision) = {
            let mut inner = self.lock()?;
            let snapshot = inner
                .operations
                .get(operation_id)
                .cloned()
                .ok_or_else(operation_not_found)?;
            if snapshot.operation.history_persisted
                || inner.persistence_in_progress.contains(operation_id)
                || inner
                    .persistence_retry_after
                    .get(operation_id)
                    .is_some_and(|retry_after| *retry_after > Instant::now())
            {
                return Ok(());
            }
            inner
                .persistence_in_progress
                .insert(operation_id.to_owned());
            (snapshot.clone(), snapshot.operation.revision)
        };

        let worker = self.clone();
        let completion = self.clone();
        let operation_id = operation_id.to_owned();
        let handle = tokio::task::spawn_blocking(move || worker.persist_snapshot(&snapshot));
        tokio::spawn(async move {
            let result = match handle.await {
                Ok(result) => result,
                Err(_) => Err(DomainError::new(
                    "operation_history_task_failed",
                    "后台任务历史写入异常结束。",
                    "任务结果仍可使用；稍后重新打开页面可再次尝试保存历史。",
                    true,
                    "stage=persist_operation; task=join_failed",
                )),
            };
            completion.finish_persistence(&operation_id, expected_revision, result);
        });
        Ok(())
    }

    fn persist_snapshot(&self, snapshot: &OmpProbeOperationSnapshot) -> Result<(), DomainError> {
        self.reconcile_history()?;
        let database = self.database.database()?;
        let operation = &snapshot.operation;
        let summary = history_summary(snapshot)?;
        database.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO operation_history (
                        operation_id,
                        target_id,
                        kind,
                        scope_kind,
                        scope_reference,
                        phase,
                        status,
                        cancellable,
                        cancellation_requested,
                        revision,
                        started_at_epoch_ms,
                        updated_at_epoch_ms,
                        finished_at_epoch_ms,
                        redacted_result_json
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
                    )
                    ON CONFLICT(operation_id) DO UPDATE SET
                        phase = excluded.phase,
                        status = excluded.status,
                        cancellation_requested = excluded.cancellation_requested,
                        revision = excluded.revision,
                        updated_at_epoch_ms = excluded.updated_at_epoch_ms,
                        finished_at_epoch_ms = excluded.finished_at_epoch_ms,
                        redacted_result_json = excluded.redacted_result_json
                    WHERE excluded.revision >= operation_history.revision",
                    rusqlite::params![
                        operation.operation_id,
                        operation.target_id,
                        operation.kind.as_str(),
                        operation.scope_kind,
                        operation.scope_reference,
                        operation.phase,
                        operation.status.as_str(),
                        bool_to_i64(operation.cancellable),
                        bool_to_i64(operation.cancellation_requested),
                        u64_to_i64("revision", operation.revision)?,
                        u64_to_i64("started_at", operation.started_at_epoch_ms)?,
                        u64_to_i64("updated_at", operation.updated_at_epoch_ms)?,
                        operation
                            .finished_at_epoch_ms
                            .map(|value| u64_to_i64("finished_at", value))
                            .transpose()?,
                        summary,
                    ],
                )
                .map_err(|error| operation_history_error("upsert", &error))?;
            Ok(())
        })
    }

    fn finish_persistence(
        &self,
        operation_id: &str,
        expected_revision: u64,
        result: Result<(), DomainError>,
    ) {
        let retry_current = {
            let Ok(mut inner) = self.lock() else {
                return;
            };
            inner.persistence_in_progress.remove(operation_id);
            let Some(snapshot) = inner.operations.get_mut(operation_id) else {
                return;
            };
            if snapshot.operation.revision != expected_revision {
                true
            } else {
                snapshot.operation.revision = next_revision(snapshot.operation.revision);
                match result {
                    Ok(()) => {
                        snapshot.operation.history_persisted = true;
                        snapshot.operation.persistence_diagnostic = None;
                        inner.persistence_retry_after.remove(operation_id);
                    }
                    Err(error) => {
                        let retryable = error.retryable;
                        snapshot.operation.history_persisted = false;
                        snapshot.operation.persistence_diagnostic = Some(error.into());
                        if retryable {
                            inner.persistence_retry_after.insert(
                                operation_id.to_owned(),
                                Instant::now() + PERSISTENCE_RETRY_DELAY,
                            );
                        }
                    }
                }
                false
            }
        };

        if retry_current {
            let _ = self.schedule_persistence(operation_id);
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, SupervisorInner>, DomainError> {
        self.inner.lock().map_err(|_| {
            DomainError::new(
                "operation_registry_poisoned",
                "后台任务注册表处于不可恢复状态。",
                "重新启动应用后重试。",
                false,
                "stage=task_supervisor_lock; mutex=poisoned",
            )
        })
    }
}

fn prune_terminal_operations(
    inner: &mut SupervisorInner,
    maximum_retained_operations: usize,
) -> Result<(), DomainError> {
    if maximum_retained_operations == 0 {
        return Err(DomainError::new(
            "operation_capacity_invalid",
            "后台任务容量配置无效。",
            "重新安装应用或修复配置。",
            false,
            "maximum_retained_operations=0",
        ));
    }

    while inner.operations.len() >= maximum_retained_operations {
        let removable = inner.operation_order.iter().position(|operation_id| {
            inner
                .operations
                .get(operation_id)
                .is_some_and(OmpProbeOperationSnapshot::is_terminal)
                && !inner.persistence_in_progress.contains(operation_id)
        });
        let Some(index) = removable else {
            return Err(DomainError::new(
                "operation_capacity_reached",
                "正在运行的后台任务已达到容量上限。",
                "等待现有任务完成后重试。",
                true,
                format!("maximum_retained_operations={maximum_retained_operations}"),
            ));
        };
        if let Some(operation_id) = inner.operation_order.remove(index) {
            inner.operations.remove(&operation_id);
            inner.persistence_retry_after.remove(&operation_id);
        }
    }
    Ok(())
}

fn history_summary(snapshot: &OmpProbeOperationSnapshot) -> Result<Option<String>, DomainError> {
    let value = match snapshot.operation.status {
        OperationStatus::Succeeded => {
            let report = snapshot.result.as_ref().ok_or_else(|| {
                DomainError::new(
                    "operation_result_inconsistent",
                    "后台任务成功状态缺少结果。",
                    "重新执行 OMP 探测。",
                    false,
                    "operation_kind=omp_probe; result=missing",
                )
            })?;
            Some(json!({
                "outcome": "succeeded",
                "probe_status": report.status,
                "capability_count": report.capabilities.len(),
                "diagnostic_count": report.diagnostics.len(),
            }))
        }
        OperationStatus::Failed | OperationStatus::TimedOut | OperationStatus::Cancelled => {
            Some(json!({
                "outcome": snapshot.operation.status.as_str(),
                "error_code": snapshot.diagnostic.as_ref().map(|diagnostic| &diagnostic.code),
            }))
        }
        OperationStatus::NeedsReconciliation => Some(json!({ "outcome": "interrupted" })),
        _ => None,
    };

    value
        .map(|value| {
            serde_json::to_string(&value).map_err(|_| {
                DomainError::new(
                    "operation_history_summary_failed",
                    "无法生成脱敏任务历史摘要。",
                    "任务结果仍可使用；稍后重试保存历史。",
                    true,
                    "stage=history_summary; serialization=failed",
                )
            })
        })
        .transpose()
}

fn validate_requested_executable(path: Option<&Path>) -> Result<(), DomainError> {
    let Some(path) = path else {
        return Ok(());
    };
    if !path.is_absolute() {
        return Err(DomainError::new(
            "omp_path_not_absolute",
            "OMP 可执行文件路径必须是绝对路径。",
            "重新选择 OMP 可执行文件。",
            false,
            "requested_path was relative",
        ));
    }
    if path.as_os_str().len() > 4_096 {
        return Err(DomainError::new(
            "omp_path_too_long",
            "OMP 可执行文件路径过长。",
            "选择有效的本机 OMP 可执行文件。",
            false,
            "requested_path exceeded 4096 bytes",
        ));
    }
    Ok(())
}

fn validate_operation_id(operation_id: &str) -> Result<(), DomainError> {
    let parsed = Uuid::parse_str(operation_id).map_err(|_| {
        DomainError::new(
            "operation_id_invalid",
            "后台任务标识无效。",
            "刷新页面后重新执行操作。",
            false,
            "operation_id was not a UUID",
        )
    })?;
    if parsed.get_version_num() != 4 || parsed.to_string() != operation_id {
        return Err(DomainError::new(
            "operation_id_invalid",
            "后台任务标识无效。",
            "刷新页面后重新执行操作。",
            false,
            "operation_id was not a canonical UUID v4",
        ));
    }
    Ok(())
}

fn operation_not_found() -> DomainError {
    DomainError::new(
        "operation_not_found",
        "后台任务不存在或已从内存中淘汰。",
        "重新执行 OMP 探测。",
        false,
        "operation lookup returned no snapshot",
    )
}

fn scope_reference(scope: &ProbeScope) -> String {
    if scope.requested_path.is_some() {
        "explicit_executable".to_owned()
    } else {
        "automatic_discovery".to_owned()
    }
}

fn operation_history_error(stage: &str, error: &rusqlite::Error) -> DomainError {
    let detail = match error {
        rusqlite::Error::SqliteFailure(code, _) => format!(
            "sqlite_code={:?}; sqlite_extended_code={}",
            code.code, code.extended_code
        ),
        _ => format!("sqlite_error_kind={:?}", std::mem::discriminant(error)),
    };
    DomainError::new(
        "operation_history_write_failed",
        "无法保存后台任务历史。",
        "任务结果仍可使用；修复数据库后重新打开页面可再次尝试。",
        true,
        format!("stage={stage}; {detail}"),
    )
}

fn bool_to_i64(value: bool) -> i64 {
    i64::from(value)
}

fn u64_to_i64(field: &str, value: u64) -> Result<i64, DomainError> {
    i64::try_from(value).map_err(|_| {
        DomainError::new(
            "operation_value_out_of_range",
            "后台任务元数据超出数据库可记录范围。",
            "重新启动应用；若问题持续，请联系支持人员。",
            false,
            format!("field={field}; value=out_of_range"),
        )
    })
}

fn next_revision(current: u64) -> u64 {
    current.saturating_add(1)
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn epoch_millis_i64() -> Result<i64, DomainError> {
    u64_to_i64("timestamp", epoch_millis())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tempfile::tempdir;

    use super::*;
    use crate::adapters::omp::OmpAdapter;
    use crate::domain::{OmpInstallation, ProbeStatus};

    #[derive(Clone)]
    struct FakeAdapter {
        delay: Duration,
        calls: Arc<AtomicUsize>,
        result: Result<ProbeReport, DomainError>,
    }

    #[async_trait]
    impl OmpAdapter for FakeAdapter {
        async fn probe_capabilities(
            &self,
            _requested_path: Option<&Path>,
        ) -> Result<ProbeReport, DomainError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            self.result.clone()
        }
    }

    struct PanickingAdapter;

    #[async_trait]
    impl OmpAdapter for PanickingAdapter {
        async fn probe_capabilities(
            &self,
            _requested_path: Option<&Path>,
        ) -> Result<ProbeReport, DomainError> {
            panic!("synthetic probe panic");
        }
    }

    fn report() -> ProbeReport {
        ProbeReport {
            target_id: TARGET_ID.to_owned(),
            status: ProbeStatus::Ready,
            installation: Some(OmpInstallation {
                executable_path: "/sensitive/path/omp".to_owned(),
                version: "1.0.0".to_owned(),
                architecture: "test".to_owned(),
                probed_at_epoch_ms: 1,
                binary_modified_at_epoch_ms: None,
            }),
            capabilities: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn ready_database() -> (tempfile::TempDir, DatabaseRuntime) {
        let directory = tempdir().expect("tempdir");
        let database = DatabaseRuntime::pending(directory.path().to_owned());
        database.run_initialization().expect("database");
        (directory, database)
    }

    fn supervisor(
        database: DatabaseRuntime,
        delay: Duration,
        timeout: Duration,
    ) -> (TaskSupervisor, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let adapter = FakeAdapter {
            delay,
            calls: Arc::clone(&calls),
            result: Ok(report()),
        };
        (
            TaskSupervisor::new(
                database,
                Arc::new(adapter),
                TaskPolicy {
                    omp_probe_timeout: timeout,
                    maximum_retained_operations: 16,
                },
            ),
            calls,
        )
    }

    async fn wait_for_terminal(
        supervisor: &TaskSupervisor,
        operation_id: &str,
    ) -> OmpProbeOperationSnapshot {
        for _ in 0..200 {
            let snapshot = supervisor
                .get_omp_probe(operation_id)
                .expect("operation snapshot");
            if snapshot.is_terminal()
                && (snapshot.operation.history_persisted
                    || snapshot.operation.persistence_diagnostic.is_some())
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("operation did not settle");
    }

    #[tokio::test]
    async fn deduplicates_an_active_probe_and_persists_a_redacted_summary() {
        let (_directory, database) = ready_database();
        let database_for_query = database.clone();
        let (supervisor, calls) =
            supervisor(database, Duration::from_millis(40), Duration::from_secs(1));

        #[cfg(windows)]
        let requested_path = PathBuf::from(r"C:\sensitive\token\omp.exe");
        #[cfg(not(windows))]
        let requested_path = PathBuf::from("/sensitive/token/omp");
        let first = supervisor
            .start_omp_probe(Some(requested_path))
            .expect("first probe");
        let second = supervisor
            .start_omp_probe(None)
            .expect("deduplicated probe");
        assert_eq!(first.operation.operation_id, second.operation.operation_id);
        assert_eq!(first.operation.scope_reference, "explicit_executable");
        assert!(!first.operation.scope_reference.contains("sensitive"));

        let terminal = wait_for_terminal(&supervisor, &first.operation.operation_id).await;
        assert_eq!(terminal.operation.status, OperationStatus::Succeeded);
        assert!(terminal.operation.history_persisted);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let database = database_for_query.database().expect("database");
        let (status, summary, scope_reference): (String, String, String) = database
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT status, redacted_result_json, scope_reference
                         FROM operation_history WHERE operation_id = ?1",
                        [&first.operation.operation_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(|error| operation_history_error("test_query", &error))
            })
            .expect("persisted operation");
        assert_eq!(status, "succeeded");
        assert_eq!(scope_reference, "explicit_executable");
        assert!(!summary.contains("/sensitive/path/omp"));
        assert!(summary.contains("\"capability_count\":0"));
    }

    #[tokio::test]
    async fn enforces_the_operation_timeout_and_non_cancellable_contract() {
        let (_directory, database) = ready_database();
        let (supervisor, _) = supervisor(
            database,
            Duration::from_millis(100),
            Duration::from_millis(10),
        );
        let started = supervisor.start_omp_probe(None).expect("probe");
        let error = supervisor
            .cancel_operation(&started.operation.operation_id)
            .expect_err("probe cancellation is not reliable");
        assert_eq!(error.code, "operation_not_cancellable");

        let terminal = wait_for_terminal(&supervisor, &started.operation.operation_id).await;
        assert_eq!(terminal.operation.status, OperationStatus::TimedOut);
        assert_eq!(
            terminal
                .diagnostic
                .as_ref()
                .map(|value| value.code.as_str()),
            Some("omp_probe_operation_timeout")
        );
    }

    #[tokio::test]
    async fn keeps_probe_degradation_available_when_history_cannot_persist() {
        let database = DatabaseRuntime::unavailable(DomainError::new(
            "database_unavailable",
            "数据库不可用。",
            "修复数据库。",
            true,
            "stage=test",
        ));
        let calls = Arc::new(AtomicUsize::new(0));
        let supervisor = TaskSupervisor::new(
            database,
            Arc::new(FakeAdapter {
                delay: Duration::ZERO,
                calls,
                result: Ok(report()),
            }),
            TaskPolicy {
                omp_probe_timeout: Duration::from_secs(1),
                maximum_retained_operations: 2,
            },
        );

        for _ in 0..4 {
            let started = supervisor.start_omp_probe(None).expect("probe");
            let terminal = wait_for_terminal(&supervisor, &started.operation.operation_id).await;
            assert_eq!(terminal.operation.status, OperationStatus::Succeeded);
            assert!(!terminal.operation.history_persisted);
            assert!(terminal.operation.persistence_diagnostic.is_some());
        }
    }

    #[tokio::test]
    async fn persists_a_failed_terminal_state_when_the_probe_worker_panics() {
        let (_directory, database) = ready_database();
        let database_for_query = database.clone();
        let supervisor = TaskSupervisor::new(
            database,
            Arc::new(PanickingAdapter),
            TaskPolicy {
                omp_probe_timeout: Duration::from_secs(1),
                maximum_retained_operations: 4,
            },
        );
        let started = supervisor.start_omp_probe(None).expect("probe");

        for _ in 0..100 {
            let persisted = supervisor
                .lock()
                .expect("supervisor")
                .operations
                .get(&started.operation.operation_id)
                .is_some_and(|snapshot| {
                    snapshot.operation.status == OperationStatus::Failed
                        && snapshot.operation.history_persisted
                });
            if persisted {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let database = database_for_query.database().expect("database");
        let status: String = database
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT status FROM operation_history WHERE operation_id = ?1",
                        [&started.operation.operation_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| operation_history_error("test_query", &error))
            })
            .expect("persisted panic status");
        assert_eq!(status, "failed");
    }

    #[test]
    fn reconciles_stale_persisted_operations_once() {
        let (_directory, database) = ready_database();
        let database_for_query = database.clone();
        let (supervisor, _) = supervisor(database, Duration::ZERO, Duration::from_secs(1));
        let database = database_for_query.database().expect("database");
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO operation_history (
                            operation_id, target_id, kind, scope_kind, scope_reference,
                            phase, status, cancellable, cancellation_requested, revision,
                            started_at_epoch_ms, updated_at_epoch_ms
                         ) VALUES (
                            'stale-operation', 'local', 'omp_probe', 'target', 'local',
                            'probing', 'running', 0, 0, 3, 1, 1
                         )",
                        [],
                    )
                    .map_err(|error| operation_history_error("test_insert", &error))?;
                Ok(())
            })
            .expect("stale history row");

        supervisor.reconcile_history().expect("reconcile");
        supervisor
            .reconcile_history()
            .expect("idempotent reconcile");
        let (status, revision): (String, i64) = database
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT status, revision FROM operation_history
                         WHERE operation_id = 'stale-operation'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| operation_history_error("test_query", &error))
            })
            .expect("reconciled row");
        assert_eq!(status, "needs_reconciliation");
        assert_eq!(revision, 4);
    }

    #[test]
    fn rejects_noncanonical_operation_ids() {
        let (_directory, database) = ready_database();
        let (supervisor, _) = supervisor(database, Duration::ZERO, Duration::from_secs(1));
        let error = supervisor
            .get_omp_probe("../operation")
            .expect_err("invalid operation id");
        assert_eq!(error.code, "operation_id_invalid");
        let error = supervisor
            .start_omp_probe(Some(PathBuf::from("relative/omp")))
            .expect_err("relative executable path");
        assert_eq!(error.code, "omp_path_not_absolute");
    }
}
