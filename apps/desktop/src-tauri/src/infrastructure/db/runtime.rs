use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use crate::domain::{DatabaseAvailability, DatabaseStatusReport, Diagnostic, DomainError};
use crate::infrastructure::secrets::sanitize_untrusted_text;

use super::{Database, DATABASE_FILENAME};

#[derive(Clone)]
pub struct DatabaseRuntime {
    inner: Arc<Mutex<RuntimeInner>>,
}

struct RuntimeInner {
    app_data_directory: Option<PathBuf>,
    database: Option<Arc<Database>>,
    report: DatabaseStatusReport,
    attempt_in_progress: bool,
    last_failed_fingerprint: Option<DatabaseStateFingerprint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DatabaseStateFingerprint {
    app_data_directory: PathFingerprint,
    database: PathFingerprint,
    wal: PathFingerprint,
    shm: PathFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PathFingerprint {
    Missing,
    File(FileFingerprint),
    Directory(FileFingerprint),
    Symlink(FileFingerprint),
    Other(FileFingerprint),
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    length: u64,
    modified_epoch_nanos: Option<u128>,
    readonly: bool,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mode: u32,
}

impl fmt::Debug for DatabaseRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let availability = self
            .inner
            .lock()
            .map(|inner| inner.report.availability)
            .ok();
        formatter
            .debug_struct("DatabaseRuntime")
            .field("availability", &availability)
            .finish_non_exhaustive()
    }
}

impl DatabaseRuntime {
    pub fn pending(app_data_directory: PathBuf) -> Self {
        let database_path = app_data_directory.join(DATABASE_FILENAME);
        Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                app_data_directory: Some(app_data_directory),
                database: None,
                report: initializing_report(1, Some(display_path(&database_path))),
                attempt_in_progress: false,
                last_failed_fingerprint: None,
            })),
        }
    }

    pub fn unavailable(error: DomainError) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                app_data_directory: None,
                database: None,
                report: recovery_report(1, false, None, None, error),
                attempt_in_progress: false,
                last_failed_fingerprint: None,
            })),
        }
    }

    pub fn snapshot(&self) -> Result<DatabaseStatusReport, DomainError> {
        Ok(self.lock()?.report.clone())
    }

    pub fn run_initialization(&self) -> Result<DatabaseStatusReport, DomainError> {
        let (app_data_directory, completion_revision) = {
            let mut inner = self.lock()?;
            if inner.report.availability == DatabaseAvailability::Ready {
                return Ok(inner.report.clone());
            }
            if inner.attempt_in_progress {
                return Ok(inner.report.clone());
            }

            let directory = inner.app_data_directory.clone().ok_or_else(|| {
                DomainError::new(
                    "database_path_unavailable",
                    "无法重新解析应用本地数据目录。",
                    "重新启动应用；若问题持续，请检查操作系统用户目录配置。",
                    false,
                    "stage=database_initialization; local_data_directory=unavailable",
                )
            })?;

            let current_fingerprint = database_state_fingerprint(&directory);
            let deterministic_failure_unchanged =
                inner.report.diagnostic.as_ref().is_some_and(|diagnostic| {
                    diagnostic.code == "database_migration_failed" && !diagnostic.retryable
                }) && inner.last_failed_fingerprint.as_ref() == Some(&current_fingerprint);
            if deterministic_failure_unchanged {
                return Ok(inner.report.clone());
            }

            let initializing_revision = next_revision(inner.report.revision)?;
            let completion_revision = next_revision(initializing_revision)?;
            inner.report = initializing_report(
                initializing_revision,
                Some(display_path(&directory.join(DATABASE_FILENAME))),
            );
            inner.attempt_in_progress = true;
            (directory, completion_revision)
        };

        let (database, report, failed_fingerprint) =
            attempt_open(&app_data_directory, completion_revision);
        let mut inner = self.lock()?;
        inner.database = database;
        inner.report = report;
        inner.attempt_in_progress = false;
        inner.last_failed_fingerprint = failed_fingerprint;
        Ok(inner.report.clone())
    }

    pub fn mark_initialization_worker_failed(&self) -> Result<(), DomainError> {
        let mut inner = self.lock()?;
        if inner.report.availability != DatabaseAvailability::Initializing {
            return Ok(());
        }

        let revision = next_revision(inner.report.revision)?;
        let database_path = inner
            .app_data_directory
            .as_deref()
            .map(|directory| display_path(&directory.join(DATABASE_FILENAME)));
        let failed_fingerprint = inner
            .app_data_directory
            .as_deref()
            .map(database_state_fingerprint);
        inner.database = None;
        inner.report = recovery_report(
            revision,
            true,
            database_path,
            None,
            DomainError::new(
                "database_initialization_task_failed",
                "数据库初始化任务异常结束。",
                "重新尝试；若问题持续，请重启应用并保留数据库与备份。",
                true,
                "stage=database_initialization; worker=join_failed",
            ),
        );
        inner.attempt_in_progress = false;
        inner.last_failed_fingerprint = failed_fingerprint;
        Ok(())
    }

    pub fn database(&self) -> Result<Arc<Database>, DomainError> {
        self.lock()?.database.clone().ok_or_else(|| {
            DomainError::new(
                "database_recovery_required",
                "OMP Manager 元数据数据库当前不可用。",
                "等待初始化完成，或先按数据库诊断完成恢复并重试。",
                true,
                "stage=require_database; availability=unavailable",
            )
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, RuntimeInner>, DomainError> {
        self.inner.lock().map_err(|_| {
            DomainError::new(
                "database_runtime_state_poisoned",
                "数据库运行状态处于不可恢复状态。",
                "重新启动应用；若问题持续，请联系支持人员。",
                false,
                "stage=database_runtime_lock; mutex=poisoned",
            )
        })
    }
}

fn attempt_open(
    app_data_directory: &Path,
    revision: u64,
) -> (
    Option<Arc<Database>>,
    DatabaseStatusReport,
    Option<DatabaseStateFingerprint>,
) {
    match Database::open_in(app_data_directory) {
        Ok(database) => {
            let report = DatabaseStatusReport {
                revision,
                availability: DatabaseAvailability::Ready,
                can_retry: false,
                database_path: Some(display_path(database.path())),
                schema_version: database.migration_outcome().current_version,
                applied_migrations: database.migration_outcome().applied_versions.clone(),
                migration_backup_path: database
                    .migration_outcome()
                    .backup_path
                    .as_deref()
                    .map(display_path),
                diagnostic: None,
            };
            (Some(Arc::new(database)), report, None)
        }
        Err(error) => {
            let (diagnostic, backup_path) = error.into_parts();
            let database_path = app_data_directory.join(DATABASE_FILENAME);
            (
                None,
                recovery_report(
                    revision,
                    true,
                    Some(display_path(&database_path)),
                    backup_path.as_deref().map(display_path),
                    diagnostic,
                ),
                Some(database_state_fingerprint(app_data_directory)),
            )
        }
    }
}

fn initializing_report(revision: u64, database_path: Option<String>) -> DatabaseStatusReport {
    DatabaseStatusReport {
        revision,
        availability: DatabaseAvailability::Initializing,
        can_retry: false,
        database_path,
        schema_version: None,
        applied_migrations: Vec::new(),
        migration_backup_path: None,
        diagnostic: None,
    }
}

fn recovery_report(
    revision: u64,
    can_retry: bool,
    database_path: Option<String>,
    migration_backup_path: Option<String>,
    error: DomainError,
) -> DatabaseStatusReport {
    DatabaseStatusReport {
        revision,
        availability: DatabaseAvailability::RecoveryRequired,
        can_retry,
        database_path,
        schema_version: None,
        applied_migrations: Vec::new(),
        migration_backup_path,
        diagnostic: Some(Diagnostic::from(error)),
    }
}

fn next_revision(current: u64) -> Result<u64, DomainError> {
    current.checked_add(1).ok_or_else(|| {
        DomainError::new(
            "database_status_revision_exhausted",
            "数据库状态版本已超出支持范围。",
            "重新启动应用；若问题持续，请联系支持人员。",
            false,
            "stage=database_status; revision=overflow",
        )
    })
}

fn database_state_fingerprint(app_data_directory: &Path) -> DatabaseStateFingerprint {
    let database = app_data_directory.join(DATABASE_FILENAME);
    DatabaseStateFingerprint {
        app_data_directory: path_fingerprint(app_data_directory),
        database: path_fingerprint(&database),
        wal: path_fingerprint(&with_suffix(&database, "-wal")),
        shm: path_fingerprint(&with_suffix(&database, "-shm")),
    }
}

fn path_fingerprint(path: &Path) -> PathFingerprint {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return PathFingerprint::Missing;
        }
        Err(_) => return PathFingerprint::Unavailable,
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        PathFingerprint::Symlink(file_fingerprint(&metadata))
    } else if metadata.is_file() {
        PathFingerprint::File(file_fingerprint(&metadata))
    } else if metadata.is_dir() {
        let mut fingerprint = file_fingerprint(&metadata);
        fingerprint.length = 0;
        fingerprint.modified_epoch_nanos = None;
        PathFingerprint::Directory(fingerprint)
    } else {
        PathFingerprint::Other(file_fingerprint(&metadata))
    }
}

fn file_fingerprint(metadata: &fs::Metadata) -> FileFingerprint {
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    FileFingerprint {
        length: metadata.len(),
        modified_epoch_nanos: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
        readonly: metadata.permissions().readonly(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        mode: metadata.permissions().mode(),
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn display_path(path: &Path) -> String {
    sanitize_untrusted_text(&path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::*;

    fn initialize(directory: &Path) -> DatabaseRuntime {
        let runtime = DatabaseRuntime::pending(directory.to_owned());
        assert_eq!(
            runtime.snapshot().expect("pending snapshot").availability,
            DatabaseAvailability::Initializing
        );
        runtime.run_initialization().expect("initialization");
        runtime
    }

    #[test]
    fn initializes_a_ready_runtime_snapshot() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DatabaseRuntime>();

        let directory = tempdir().expect("tempdir");
        let runtime = initialize(directory.path());
        let report = runtime.snapshot().expect("snapshot");

        assert_eq!(report.availability, DatabaseAvailability::Ready);
        assert!(!report.can_retry);
        assert_eq!(report.schema_version, Some(9));
        assert_eq!(report.applied_migrations, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert!(report.database_path.is_some());
        assert!(report.diagnostic.is_none());
        runtime.database().expect("ready database");
    }

    #[test]
    fn keeps_the_application_available_and_allows_a_retry_after_change() {
        let directory = tempdir().expect("tempdir");
        let database_path = directory.path().join(DATABASE_FILENAME);
        fs::create_dir(&database_path).expect("blocking directory");

        let runtime = initialize(directory.path());
        let failed = runtime.snapshot().expect("failed snapshot");
        assert_eq!(failed.availability, DatabaseAvailability::RecoveryRequired);
        assert!(failed.can_retry);
        assert_eq!(
            failed.diagnostic.as_ref().map(|value| value.code.as_str()),
            Some("database_path_invalid")
        );
        assert!(runtime.database().is_err());

        fs::remove_dir(&database_path).expect("remove blocking directory");
        let recovered = runtime.run_initialization().expect("retry");
        assert_eq!(recovered.availability, DatabaseAvailability::Ready);
        assert!(recovered.revision > failed.revision);
        runtime.database().expect("recovered database");
    }

    #[test]
    fn reports_the_exact_backup_and_deduplicates_unchanged_failures() {
        let directory = tempdir().expect("tempdir");
        let database_path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&database_path).expect("open version one");
        connection
            .execute_batch(include_str!("migrations/0001_initial.sql"))
            .expect("apply version one");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (1, 1)",
                [],
            )
            .expect("record version one");
        connection
            .execute(
                "INSERT INTO execution_targets (
                    id,
                    kind,
                    label,
                    capabilities_json,
                    created_at_epoch_ms
                ) VALUES ('local', 'ssh', 'Conflicting target', '{}', 1)",
                [],
            )
            .expect("conflicting local target");
        drop(connection);

        let runtime = initialize(directory.path());
        let report = runtime.snapshot().expect("snapshot");
        assert_eq!(report.availability, DatabaseAvailability::RecoveryRequired);
        assert!(report.can_retry);
        assert_eq!(
            report.diagnostic.as_ref().map(|value| value.code.as_str()),
            Some("database_migration_failed")
        );
        assert_eq!(
            report.diagnostic.as_ref().map(|value| value.retryable),
            Some(false)
        );
        let backup_path = report
            .migration_backup_path
            .as_deref()
            .map(PathBuf::from)
            .expect("new migration backup");
        assert!(backup_path.is_file());

        let repeated = runtime.run_initialization().expect("deduplicated retry");
        assert_eq!(repeated, report);
        let backup_count = fs::read_dir(directory.path())
            .expect("database directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|value| value == "bak"))
            .count();
        assert_eq!(backup_count, 1);
    }

    #[test]
    fn unavailable_runtime_has_no_retry_target() {
        let runtime = DatabaseRuntime::unavailable(DomainError::new(
            "path_unavailable",
            "路径不可用。",
            "重新启动。",
            false,
            "stage=test",
        ));
        let report = runtime.snapshot().expect("snapshot");
        assert_eq!(report.availability, DatabaseAvailability::RecoveryRequired);
        assert!(!report.can_retry);
        assert!(runtime.run_initialization().is_err());
    }

    #[test]
    fn records_a_worker_failure_even_before_the_worker_begins() {
        let directory = tempdir().expect("tempdir");
        let runtime = DatabaseRuntime::pending(directory.path().to_owned());
        runtime
            .mark_initialization_worker_failed()
            .expect("record worker failure");

        let report = runtime.snapshot().expect("snapshot");
        assert_eq!(report.availability, DatabaseAvailability::RecoveryRequired);
        assert!(report.can_retry);
        assert_eq!(
            report.diagnostic.as_ref().map(|value| value.code.as_str()),
            Some("database_initialization_task_failed")
        );
    }
}
