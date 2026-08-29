mod migrations;
mod runtime;

use std::fmt;
use std::fs;
use std::io;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::domain::DomainError;

pub use migrations::MigrationOutcome;
pub use runtime::DatabaseRuntime;

pub const DATABASE_FILENAME: &str = "metadata.sqlite3";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DatabaseFileIdentity {
    stable_value_a: u64,
    stable_value_b: u64,
}

#[derive(Debug)]
struct DatabaseEntry {
    existed: bool,
    non_empty: bool,
    identity: Option<DatabaseFileIdentity>,
}

#[derive(Debug)]
pub struct DatabaseOpenError {
    diagnostic: Box<DomainError>,
    migration_backup_path: Option<PathBuf>,
}

impl DatabaseOpenError {
    pub fn new(diagnostic: DomainError, migration_backup_path: Option<PathBuf>) -> Self {
        Self {
            diagnostic: Box::new(diagnostic),
            migration_backup_path,
        }
    }

    pub fn into_parts(self) -> (DomainError, Option<PathBuf>) {
        (*self.diagnostic, self.migration_backup_path)
    }
}

impl From<DomainError> for DatabaseOpenError {
    fn from(diagnostic: DomainError) -> Self {
        Self::new(diagnostic, None)
    }
}

impl Deref for DatabaseOpenError {
    type Target = DomainError;

    fn deref(&self) -> &Self::Target {
        &self.diagnostic
    }
}

impl fmt::Display for DatabaseOpenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.diagnostic.fmt(formatter)
    }
}

impl std::error::Error for DatabaseOpenError {}

pub struct Database {
    path: PathBuf,
    connection: Mutex<Connection>,
    migration_outcome: MigrationOutcome,
}

impl fmt::Debug for Database {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Database")
            .field("path", &"<application-data>")
            .field("migration_outcome", &self.migration_outcome)
            .finish_non_exhaustive()
    }
}

impl Database {
    pub fn open_in(app_data_directory: &Path) -> Result<Self, DatabaseOpenError> {
        prepare_private_directory(app_data_directory)?;
        Self::open(app_data_directory.join(DATABASE_FILENAME))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseOpenError> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return Err(DomainError::new(
                "database_path_invalid",
                "OMP Manager 数据库路径必须是绝对路径。",
                "重新启动应用；若问题持续，请检查应用数据目录配置。",
                false,
                "stage=open; path=relative",
            )
            .into());
        }

        let parent = path.parent().ok_or_else(|| {
            DomainError::new(
                "database_path_invalid",
                "OMP Manager 数据库路径缺少父目录。",
                "重新启动应用；若问题持续，请检查应用数据目录配置。",
                false,
                "stage=open; parent=missing",
            )
        })?;
        prepare_private_directory(parent)?;

        let database_entry = validate_database_entry(path)?;
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| {
            database_error(
                "open",
                "无法打开 OMP Manager 元数据数据库。",
                "确认应用数据目录可写且磁盘空间充足后重试。",
                true,
                &error,
            )
        })?;

        let opened_identity = read_database_identity(path)?;
        if database_entry
            .identity
            .as_ref()
            .is_some_and(|identity| identity != &opened_identity)
        {
            return Err(database_identity_changed("open").into());
        }

        configure_connection_safety(&connection)?;
        migrations::preflight(&connection)?;
        verify_database_identity(path, &opened_identity, "before_durable_configuration")?;
        restrict_file_permissions(path)?;
        configure_durable_connection(&connection)?;

        let migration_identity = read_database_identity(path)?;
        #[cfg(unix)]
        if migration_identity != opened_identity {
            return Err(database_identity_changed("after_durable_configuration").into());
        }
        let migration_outcome = migrations::migrate(
            &mut connection,
            path,
            database_entry.existed && database_entry.non_empty,
            &migration_identity,
        )?;

        Ok(Self {
            path: path.to_owned(),
            connection: Mutex::new(connection),
            migration_outcome,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn migration_outcome(&self) -> &MigrationOutcome {
        &self.migration_outcome
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, DomainError>,
    ) -> Result<T, DomainError> {
        let connection = self.lock_connection()?;
        operation(&connection)
    }

    pub fn with_connection_mut<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, DomainError>,
    ) -> Result<T, DomainError> {
        let mut connection = self.lock_connection()?;
        operation(&mut connection)
    }

    fn lock_connection(&self) -> Result<MutexGuard<'_, Connection>, DomainError> {
        self.connection.lock().map_err(|_| {
            DomainError::new(
                "database_connection_poisoned",
                "OMP Manager 数据库连接处于不可恢复状态。",
                "重新启动应用；若问题持续，请保留数据库并联系支持人员。",
                false,
                "stage=lock; mutex=poisoned",
            )
        })
    }
}

fn prepare_private_directory(path: &Path) -> Result<(), DomainError> {
    fs::create_dir_all(path).map_err(|error| {
        DomainError::new(
            "database_directory_unavailable",
            "无法准备 OMP Manager 应用数据目录。",
            "确认当前用户对应用数据目录有写入权限后重试。",
            true,
            format!("stage=create_directory; {}", io_error_detail(&error)),
        )
    })?;

    let metadata = fs::metadata(path).map_err(|error| {
        DomainError::new(
            "database_directory_unavailable",
            "无法检查 OMP Manager 应用数据目录。",
            "确认目录仍然存在且当前用户有权访问。",
            true,
            format!("stage=inspect_directory; {}", io_error_detail(&error)),
        )
    })?;
    if !metadata.is_dir() {
        return Err(DomainError::new(
            "database_directory_invalid",
            "OMP Manager 应用数据路径不是目录。",
            "移走同名文件或修正应用数据目录后重试。",
            false,
            "stage=inspect_directory; type=not_directory",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            DomainError::new(
                "database_directory_permissions_failed",
                "无法限制 OMP Manager 应用数据目录权限。",
                "确认目录由当前用户拥有且支持 Unix 权限后重试。",
                false,
                format!("stage=chmod_directory; {}", io_error_detail(&error)),
            )
        })?;
    }

    Ok(())
}

fn validate_database_entry(path: &Path) -> Result<DatabaseEntry, DomainError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(DomainError::new(
            "database_path_symlink_rejected",
            "OMP Manager 拒绝通过符号链接打开元数据数据库。",
            "移走数据库路径处的符号链接后重试。",
            false,
            "stage=inspect_database; type=symlink",
        )),
        Ok(metadata) if !metadata.is_file() => Err(DomainError::new(
            "database_path_invalid",
            "OMP Manager 数据库路径不是普通文件。",
            "移走同名目录或特殊文件后重试。",
            false,
            "stage=inspect_database; type=not_regular_file",
        )),
        Ok(metadata) => Ok(DatabaseEntry {
            existed: true,
            non_empty: metadata.len() > 0,
            identity: Some(DatabaseFileIdentity::from_metadata(&metadata)),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DatabaseEntry {
            existed: false,
            non_empty: false,
            identity: None,
        }),
        Err(error) => Err(DomainError::new(
            "database_path_unavailable",
            "无法检查 OMP Manager 元数据数据库。",
            "确认应用数据目录权限后重试。",
            true,
            format!("stage=inspect_database; {}", io_error_detail(&error)),
        )),
    }
}

impl DatabaseFileIdentity {
    #[cfg(unix)]
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;

        Self {
            stable_value_a: metadata.dev(),
            stable_value_b: metadata.ino(),
        }
    }

    #[cfg(not(unix))]
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        let modified_epoch_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
            .unwrap_or_default();

        Self {
            stable_value_a: metadata.len(),
            stable_value_b: modified_epoch_nanos,
        }
    }
}

pub(super) fn read_database_identity(path: &Path) -> Result<DatabaseFileIdentity, DomainError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        DomainError::new(
            "database_identity_unavailable",
            "无法复核 OMP Manager 元数据数据库身份。",
            "确认数据库未被移动或替换后重试。",
            true,
            format!("stage=read_identity; {}", io_error_detail(&error)),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(database_identity_changed("read_identity"));
    }

    Ok(DatabaseFileIdentity::from_metadata(&metadata))
}

pub(super) fn read_database_handle_identity(
    file: &fs::File,
    stage: &str,
) -> Result<DatabaseFileIdentity, DomainError> {
    let metadata = file.metadata().map_err(|error| {
        DomainError::new(
            "database_identity_unavailable",
            "无法复核 OMP Manager 数据库文件句柄身份。",
            "确认应用数据目录仍可访问且存储设备工作正常后重试。",
            true,
            format!("stage={stage}; {}", io_error_detail(&error)),
        )
    })?;

    Ok(DatabaseFileIdentity::from_metadata(&metadata))
}

pub(super) fn verify_database_identity(
    path: &Path,
    expected: &DatabaseFileIdentity,
    stage: &str,
) -> Result<(), DomainError> {
    if read_database_identity(path)? == *expected {
        return Ok(());
    }

    Err(database_identity_changed(stage))
}

fn database_identity_changed(stage: &str) -> DomainError {
    DomainError::new(
        "database_identity_changed",
        "OMP Manager 元数据数据库在操作期间被替换。",
        "关闭其他可能修改应用数据的进程，保留现有文件并重新启动应用。",
        true,
        format!("stage={stage}; identity=changed"),
    )
}

fn restrict_file_permissions(path: &Path) -> Result<(), DomainError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            DomainError::new(
                "database_permissions_failed",
                "无法限制 OMP Manager 元数据数据库权限。",
                "确认数据库由当前用户拥有且支持 Unix 权限后重试。",
                false,
                format!("stage=chmod_database; {}", io_error_detail(&error)),
            )
        })?;
    }

    #[cfg(not(unix))]
    let _ = path;

    Ok(())
}

fn configure_connection_safety(connection: &Connection) -> Result<(), DomainError> {
    connection.busy_timeout(BUSY_TIMEOUT).map_err(|error| {
        database_error(
            "busy_timeout",
            "无法配置数据库锁等待策略。",
            "关闭其他 OMP Manager 实例后重试。",
            true,
            &error,
        )
    })?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| {
            database_error(
                "foreign_keys",
                "无法启用数据库外键保护。",
                "重新启动应用；当前数据库未进入业务写入状态。",
                false,
                &error,
            )
        })?;
    connection
        .pragma_update(None, "trusted_schema", false)
        .map_err(|error| {
            database_error(
                "trusted_schema",
                "无法启用数据库安全架构模式。",
                "升级系统 SQLite 支持或重新安装应用后重试。",
                false,
                &error,
            )
        })?;
    connection
        .pragma_update(None, "recursive_triggers", true)
        .map_err(|error| {
            database_error(
                "recursive_triggers",
                "无法启用数据库递归触发器保护。",
                "升级系统 SQLite 支持或重新安装应用后重试。",
                false,
                &error,
            )
        })?;

    let foreign_keys_enabled: bool = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|error| {
            database_error(
                "verify_foreign_keys",
                "无法验证数据库外键保护。",
                "重新启动应用；当前数据库未进入业务写入状态。",
                false,
                &error,
            )
        })?;
    if !foreign_keys_enabled {
        return Err(DomainError::new(
            "database_foreign_keys_unavailable",
            "数据库外键保护未生效。",
            "重新安装应用或升级 SQLite 支持后重试。",
            false,
            "stage=verify_foreign_keys; enabled=false",
        ));
    }

    let recursive_triggers_enabled: bool = connection
        .query_row("PRAGMA recursive_triggers", [], |row| row.get(0))
        .map_err(|error| {
            database_error(
                "verify_recursive_triggers",
                "无法验证数据库递归触发器保护。",
                "重新启动应用；当前数据库未进入业务写入状态。",
                false,
                &error,
            )
        })?;
    if !recursive_triggers_enabled {
        return Err(DomainError::new(
            "database_recursive_triggers_unavailable",
            "数据库递归触发器保护未生效。",
            "重新安装应用或升级 SQLite 支持后重试。",
            false,
            "stage=verify_recursive_triggers; enabled=false",
        ));
    }

    Ok(())
}

fn configure_durable_connection(connection: &Connection) -> Result<(), DomainError> {
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|error| {
            database_error(
                "journal_mode",
                "无法启用数据库 WAL 日志模式。",
                "确认应用数据目录支持 SQLite WAL 文件后重试。",
                true,
                &error,
            )
        })?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(DomainError::new(
            "database_wal_unavailable",
            "当前存储位置不支持数据库 WAL 日志模式。",
            "将应用数据目录移动到支持文件锁与 WAL 的本地文件系统后重试。",
            false,
            "stage=journal_mode; result=not_wal",
        ));
    }

    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| {
            database_error(
                "synchronous",
                "无法启用数据库持久化写入策略。",
                "确认数据库可写后重试。",
                true,
                &error,
            )
        })?;

    Ok(())
}

#[cfg(test)]
fn configure_connection(connection: &Connection) -> Result<(), DomainError> {
    configure_connection_safety(connection)?;
    configure_durable_connection(connection)
}

fn database_error(
    stage: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    error: &rusqlite::Error,
) -> DomainError {
    DomainError::new(
        "database_unavailable",
        message,
        suggestion,
        retryable,
        format!("stage={stage}; {}", sqlite_error_detail(error)),
    )
}

fn sqlite_error_detail(error: &rusqlite::Error) -> String {
    match error {
        rusqlite::Error::SqliteFailure(code, _) => format!(
            "sqlite_code={:?}; sqlite_extended_code={}",
            code.code, code.extended_code
        ),
        _ => format!("sqlite_error_kind={:?}", std::mem::discriminant(error)),
    }
}

fn io_error_detail(error: &io::Error) -> String {
    format!(
        "io_kind={:?}; raw_os_code={:?}",
        error.kind(),
        error.raw_os_error()
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Barrier};

    use rusqlite::{Connection, ErrorCode};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn initializes_schema_pragmas_and_local_target() {
        let directory = tempdir().expect("tempdir");
        let database = Database::open_in(directory.path()).expect("database");

        assert_eq!(
            database.migration_outcome().applied_versions,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9]
        );
        assert_eq!(database.migration_outcome().current_version, Some(9));
        assert!(database.migration_outcome().backup_path.is_none());

        let connection = database.connection.lock().expect("connection");
        let versions: Vec<i64> = connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .expect("prepare versions")
            .query_map([], |row| row.get(0))
            .expect("query versions")
            .collect::<Result<_, _>>()
            .expect("collect versions");
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8, 9]);

        let local_target: (String, String) = connection
            .query_row(
                "SELECT id, kind FROM execution_targets WHERE id = 'local'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("local target");
        assert_eq!(local_target, ("local".to_owned(), "local".to_owned()));

        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        let foreign_keys: bool = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign keys");
        assert!(foreign_keys);
        let recursive_triggers: bool = connection
            .query_row("PRAGMA recursive_triggers", [], |row| row.get(0))
            .expect("recursive triggers");
        assert!(recursive_triggers);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(database.path())
                .expect("database metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn session_identity_includes_profile_and_annotations_still_reference_rows() {
        let directory = tempdir().expect("tempdir");
        let database = Database::open_in(directory.path()).expect("database");
        let connection = database.connection.lock().expect("connection");
        connection
            .execute(
                "INSERT INTO session_index (
                    target_id, profile, session_path, session_id, cwd, title,
                    modified_at_epoch_ms, status, fingerprint
                 ) VALUES ('local', 'first', '/same/session.jsonl', 'one', '/tmp', '', 1, 'unknown', 'one')",
                [],
            )
            .expect("first profile session");
        let first_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO session_annotations (
                    session_index_id, target_id, favorite, tags_json, updated_at_epoch_ms
                 ) VALUES (?1, 'local', 1, '[]', 1)",
                [first_id],
            )
            .expect("annotation");
        connection
            .execute(
                "INSERT INTO session_index (
                    target_id, profile, session_path, session_id, cwd, title,
                    modified_at_epoch_ms, status, fingerprint
                 ) VALUES ('local', 'second', '/same/session.jsonl', 'two', '/tmp', '', 2, 'unknown', 'two')",
                [],
            )
            .expect("same path in second profile");

        let session_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM session_index
                 WHERE target_id = 'local' AND session_path = '/same/session.jsonl'",
                [],
                |row| row.get(0),
            )
            .expect("session count");
        let favorite: i64 = connection
            .query_row(
                "SELECT favorite FROM session_annotations WHERE session_index_id = ?1",
                [first_id],
                |row| row.get(0),
            )
            .expect("preserved annotation reference");
        assert_eq!(session_count, 2);
        assert_eq!(favorite, 1);
    }

    #[test]
    fn reopening_an_up_to_date_database_is_idempotent() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join(DATABASE_FILENAME);
        drop(Database::open(&path).expect("first open"));

        let database = Database::open(&path).expect("second open");
        assert!(database.migration_outcome().applied_versions.is_empty());
        assert_eq!(database.migration_outcome().current_version, Some(9));
        assert!(database.migration_outcome().backup_path.is_none());
    }

    #[test]
    fn concurrent_openers_apply_pending_migrations_once() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&path).expect("open version one");
        connection
            .execute_batch(include_str!("migrations/0001_initial.sql"))
            .expect("apply version one");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (1, 1)",
                [],
            )
            .expect("record version one");
        drop(connection);

        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    Database::open(path).map(|database| database.migration_outcome().clone())
                })
            })
            .collect();
        barrier.wait();

        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("database opener thread"))
            .collect::<Result<_, _>>()
            .expect("both database openers");
        let migration_winners = outcomes
            .iter()
            .filter(|outcome| outcome.applied_versions == [2, 3, 4, 5, 6, 7, 8, 9])
            .count();
        let already_current = outcomes
            .iter()
            .filter(|outcome| outcome.applied_versions.is_empty())
            .count();
        assert_eq!(migration_winners, 1);
        assert_eq!(already_current, 1);

        let backup_count = fs::read_dir(directory.path())
            .expect("database directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|value| value == "bak"))
            .count();
        assert_eq!(backup_count, 1);
    }

    #[test]
    fn upgrades_version_one_from_a_consistent_backup() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&path).expect("open version one");
        connection
            .execute_batch(include_str!("migrations/0001_initial.sql"))
            .expect("apply version one");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (1, 1)",
                [],
            )
            .expect("record version one");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .expect("enable WAL");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable automatic checkpoint");

        const WAL_SENTINEL: &str = "wal-only-target-sentinel";
        connection
            .execute(
                "INSERT INTO execution_targets (
                    id,
                    kind,
                    label,
                    capabilities_json,
                    created_at_epoch_ms
                ) VALUES (?1, 'local', 'WAL sentinel', '{}', 1)",
                [WAL_SENTINEL],
            )
            .expect("write committed WAL sentinel");

        let mut wal_name = path.as_os_str().to_os_string();
        wal_name.push("-wal");
        let wal_path = PathBuf::from(wal_name);
        assert!(file_contains(&wal_path, WAL_SENTINEL.as_bytes()));
        assert!(!file_contains(&path, WAL_SENTINEL.as_bytes()));

        let database = Database::open(&path).expect("upgrade database");
        assert_eq!(
            database.migration_outcome().applied_versions,
            vec![2, 3, 4, 5, 6, 7, 8, 9]
        );
        let backup_path = database
            .migration_outcome()
            .backup_path
            .as_ref()
            .expect("migration backup");
        assert!(backup_path.is_file());

        let backup =
            Connection::open_with_flags(backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("open backup");
        let backup_versions: i64 = backup
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("backup versions");
        assert_eq!(backup_versions, 1);
        let wal_sentinel_count: i64 = backup
            .query_row(
                "SELECT COUNT(*) FROM execution_targets WHERE id = ?1",
                [WAL_SENTINEL],
                |row| row.get(0),
            )
            .expect("WAL sentinel in backup");
        assert_eq!(wal_sentinel_count, 1);
        let foundation_table_in_backup: bool = backup
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_schema
                    WHERE type = 'table' AND name = 'authorized_roots'
                )",
                [],
                |row| row.get(0),
            )
            .expect("foundation table lookup");
        assert!(!foundation_table_in_backup);
    }

    fn file_contains(path: &Path, needle: &[u8]) -> bool {
        fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
            .unwrap_or(false)
    }

    #[test]
    fn foreign_keys_reject_cross_target_orphans() {
        let directory = tempdir().expect("tempdir");
        let database = Database::open_in(directory.path()).expect("database");
        let connection = database.connection.lock().expect("connection");
        let error = connection
            .execute(
                "INSERT INTO projects (
                    target_id,
                    canonical_path,
                    canonical_key,
                    display_path,
                    created_at_epoch_ms,
                    last_used_at_epoch_ms
                ) VALUES ('missing-target', '/project', '/project', '/project', 1, 1)",
                [],
            )
            .expect_err("orphan target must fail");

        match error {
            rusqlite::Error::SqliteFailure(code, _) => {
                assert_eq!(code.code, ErrorCode::ConstraintViolation);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn preflight_rejects_existing_foreign_key_violations() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&path).expect("open version one");
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
            .pragma_update(None, "foreign_keys", false)
            .expect("simulate a legacy writer without foreign keys");
        connection
            .execute(
                "INSERT INTO projects (
                    target_id,
                    canonical_path,
                    canonical_key,
                    display_path,
                    created_at_epoch_ms,
                    last_used_at_epoch_ms
                ) VALUES ('missing-target', '/orphan', '/orphan', '/orphan', 1, 1)",
                [],
            )
            .expect("insert orphan while foreign keys are disabled");
        drop(connection);

        let error = Database::open(&path).expect_err("invalid foreign key must fail");
        assert_eq!(error.code, "database_foreign_key_integrity_failed");
    }

    #[test]
    fn preflight_does_not_enable_wal_for_a_newer_database() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&path).expect("open newer database");
        connection
            .execute_batch(include_str!("migrations/0001_initial.sql"))
            .expect("apply base schema");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (99, 1)",
                [],
            )
            .expect("record newer version");
        drop(connection);

        let error = Database::open(&path).expect_err("newer database must fail");
        assert_eq!(error.code, "database_schema_newer_than_application");

        let connection = Connection::open(&path).expect("reopen newer database");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        assert_eq!(journal_mode.to_ascii_lowercase(), "delete");
    }

    #[test]
    fn migration_rejects_a_conflicting_local_target_seed() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&path).expect("open version one");
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

        let error = Database::open(&path).expect_err("conflicting seed must fail");
        assert_eq!(error.code, "database_migration_failed");
        assert!(error
            .technical_detail_redacted
            .contains("backup_created=true"));

        let connection = Connection::open(&path).expect("reopen rolled back database");
        let version_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration history");
        let local_kind: String = connection
            .query_row(
                "SELECT kind FROM execution_targets WHERE id = 'local'",
                [],
                |row| row.get(0),
            )
            .expect("conflicting local target remains");
        assert_eq!(version_count, 1);
        assert_eq!(local_kind, "ssh");
    }

    #[test]
    fn target_scope_guards_reject_existing_but_mismatched_targets() {
        let directory = tempdir().expect("tempdir");
        let database = Database::open_in(directory.path()).expect("database");
        let connection = database.connection.lock().expect("connection");
        connection
            .execute(
                "INSERT INTO execution_targets (
                    id,
                    kind,
                    label,
                    capabilities_json,
                    created_at_epoch_ms
                ) VALUES ('remote-test', 'ssh', 'Remote test', '{}', 1)",
                [],
            )
            .expect("remote target");
        connection
            .execute(
                "INSERT INTO projects (
                    target_id,
                    canonical_path,
                    canonical_key,
                    display_path,
                    created_at_epoch_ms,
                    last_used_at_epoch_ms
                ) VALUES ('local', '/project', '/project', '/project', 1, 1)",
                [],
            )
            .expect("local project");
        let project_id = connection.last_insert_rowid();

        let error = connection
            .execute(
                "INSERT INTO project_bindings (
                    target_id,
                    project_id,
                    path_prefix,
                    path_prefix_key,
                    profile,
                    updated_at_epoch_ms
                ) VALUES ('remote-test', ?1, '/project', '/project', 'default', 1)",
                [project_id],
            )
            .expect_err("cross-target binding must fail");

        match error {
            rusqlite::Error::SqliteFailure(code, _) => {
                assert_eq!(code.code, ErrorCode::ConstraintViolation);
            }
            other => panic!("unexpected error: {other:?}"),
        }

        connection
            .execute(
                "INSERT INTO project_bindings (
                    target_id,
                    project_id,
                    path_prefix,
                    path_prefix_key,
                    profile,
                    updated_at_epoch_ms
                ) VALUES ('local', ?1, '/project', '/project', 'default', 1)",
                [project_id],
            )
            .expect("valid local binding");
        let parent_update_error = connection
            .execute(
                "UPDATE projects SET target_id = 'remote-test' WHERE id = ?1",
                [project_id],
            )
            .expect_err("parent update must not break target scope");
        assert!(matches!(
            parent_update_error,
            rusqlite::Error::SqliteFailure(_, _)
        ));
    }

    #[test]
    fn local_target_identity_cannot_be_retyped_or_deleted() {
        let directory = tempdir().expect("tempdir");
        let database = Database::open_in(directory.path()).expect("database");
        let connection = database.connection.lock().expect("connection");

        let update_error = connection
            .execute(
                "UPDATE execution_targets SET kind = 'ssh' WHERE id = 'local'",
                [],
            )
            .expect_err("local target kind must be immutable");
        let delete_error = connection
            .execute("DELETE FROM execution_targets WHERE id = 'local'", [])
            .expect_err("local target must not be deleted");
        connection
            .execute(
                "INSERT INTO app_settings (
                    target_id,
                    key,
                    value_json,
                    updated_at_epoch_ms
                ) VALUES ('local', 'replace-guard', '{}', 1)",
                [],
            )
            .expect("local child row");
        let replace_error = connection
            .execute(
                "INSERT OR REPLACE INTO execution_targets (
                    id,
                    kind,
                    label,
                    capabilities_json,
                    created_at_epoch_ms
                ) VALUES ('local', 'ssh', 'Replacement', '{}', 1)",
                [],
            )
            .expect_err("replace must not bypass local target protection");

        assert!(matches!(update_error, rusqlite::Error::SqliteFailure(_, _)));
        assert!(matches!(delete_error, rusqlite::Error::SqliteFailure(_, _)));
        assert!(matches!(
            replace_error,
            rusqlite::Error::SqliteFailure(_, _)
        ));
        let child_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_settings
                 WHERE target_id = 'local' AND key = 'replace-guard'",
                [],
                |row| row.get(0),
            )
            .expect("local child row remains");
        assert_eq!(child_count, 1);
    }

    #[test]
    fn rejects_a_database_path_symlink() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let directory = tempdir().expect("tempdir");
            let real_path = directory.path().join("real.sqlite3");
            fs::write(&real_path, []).expect("real file");
            let link_path = directory.path().join(DATABASE_FILENAME);
            symlink(&real_path, &link_path).expect("symlink");

            let error = Database::open(&link_path).expect_err("symlink must fail");
            assert_eq!(error.code, "database_path_symlink_rejected");
        }
    }
}
