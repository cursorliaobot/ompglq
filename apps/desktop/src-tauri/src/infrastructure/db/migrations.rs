use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{
    backup::{Backup, StepResult},
    params, Connection, OpenFlags, TransactionBehavior,
};

use crate::domain::DomainError;

use super::{
    io_error_detail, read_database_handle_identity, read_database_identity, sqlite_error_detail,
    verify_database_identity, DatabaseFileIdentity, DatabaseOpenError,
};

const BACKUP_TIMEOUT: Duration = Duration::from_secs(30);
const BACKUP_RETRY_DELAY: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub applied_versions: Vec<u32>,
    pub current_version: Option<u32>,
    pub backup_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy)]
struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "m1_foundation",
        sql: include_str!("migrations/0002_m1_foundation.sql"),
    },
    Migration {
        version: 3,
        name: "target_scope_guards",
        sql: include_str!("migrations/0003_target_scope_guards.sql"),
    },
    Migration {
        version: 4,
        name: "parent_scope_guards",
        sql: include_str!("migrations/0004_parent_scope_guards.sql"),
    },
    Migration {
        version: 5,
        name: "project_integrity",
        sql: include_str!("migrations/0005_project_integrity.sql"),
    },
    Migration {
        version: 6,
        name: "session_index_foundation",
        sql: include_str!("migrations/0006_session_index_foundation.sql"),
    },
    Migration {
        version: 7,
        name: "session_provider_metadata",
        sql: include_str!("migrations/0007_session_provider_metadata.sql"),
    },
    Migration {
        version: 8,
        name: "session_profile_identity",
        sql: include_str!("migrations/0008_session_profile_identity.sql"),
    },
    Migration {
        version: 9,
        name: "session_profile_key",
        sql: include_str!("migrations/0009_session_profile_key.sql"),
    },
];

pub(super) fn migrate(
    connection: &mut Connection,
    database_path: &Path,
    database_preexisted: bool,
    expected_identity: &DatabaseFileIdentity,
) -> Result<MigrationOutcome, DatabaseOpenError> {
    run_migrations(
        connection,
        database_path,
        database_preexisted,
        expected_identity,
        MIGRATIONS,
    )
}

pub(super) fn preflight(connection: &Connection) -> Result<(), DomainError> {
    validate_migration_definitions(MIGRATIONS)?;
    verify_database_integrity(connection)?;
    verify_foreign_key_integrity(connection)?;
    let applied = load_applied_versions(connection)?;
    validate_applied_prefix(&applied, MIGRATIONS)
}

fn run_migrations(
    connection: &mut Connection,
    database_path: &Path,
    database_preexisted: bool,
    expected_identity: &DatabaseFileIdentity,
    migrations: &[Migration],
) -> Result<MigrationOutcome, DatabaseOpenError> {
    validate_migration_definitions(migrations)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            migration_error(
                "acquire_lock",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;

    verify_database_identity(database_path, expected_identity, "migration_lock")?;
    verify_database_integrity(&transaction)?;
    verify_foreign_key_integrity(&transaction)?;
    let applied = load_applied_versions(&transaction)?;
    validate_applied_prefix(&applied, migrations)?;

    let pending = &migrations[applied.len()..];
    if pending.is_empty() {
        transaction.commit().map_err(|error| {
            migration_error(
                "release_lock",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;

        return Ok(MigrationOutcome {
            applied_versions: Vec::new(),
            current_version: applied.last().copied(),
            backup_path: None,
        });
    }

    let backup_path = if database_preexisted {
        Some(create_consistent_backup(database_path, expected_identity)?)
    } else {
        None
    };

    let applied_at_epoch_ms = attach_backup(now_epoch_ms(), &backup_path)?;
    let mut newly_applied = Vec::with_capacity(pending.len());

    for migration in pending {
        attach_backup(
            transaction.execute_batch(migration.sql).map_err(|error| {
                migration_error(
                    "apply",
                    Some(migration),
                    backup_path.is_some(),
                    sqlite_error_is_retryable(&error),
                    &sqlite_error_detail(&error),
                )
            }),
            &backup_path,
        )?;

        attach_backup(
            transaction
                .execute(
                    "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (?1, ?2)",
                    params![i64::from(migration.version), applied_at_epoch_ms],
                )
                .map_err(|error| {
                    migration_error(
                        "record",
                        Some(migration),
                        backup_path.is_some(),
                        sqlite_error_is_retryable(&error),
                        &sqlite_error_detail(&error),
                    )
                }),
            &backup_path,
        )?;
        newly_applied.push(migration.version);
    }

    attach_backup(verify_foreign_key_integrity(&transaction), &backup_path)?;
    attach_backup(
        verify_database_identity(database_path, expected_identity, "before_migration_commit"),
        &backup_path,
    )?;

    attach_backup(
        transaction.commit().map_err(|error| {
            migration_error(
                "commit",
                pending.last(),
                backup_path.is_some(),
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        }),
        &backup_path,
    )?;

    Ok(MigrationOutcome {
        applied_versions: newly_applied,
        current_version: migrations.last().map(|migration| migration.version),
        backup_path,
    })
}

fn validate_migration_definitions(migrations: &[Migration]) -> Result<(), DomainError> {
    let valid = !migrations.is_empty()
        && migrations[0].version == 1
        && migrations.windows(2).all(|pair| {
            pair[0]
                .version
                .checked_add(1)
                .is_some_and(|expected| expected == pair[1].version)
        });

    if valid {
        return Ok(());
    }

    Err(DomainError::new(
        "database_migration_manifest_invalid",
        "应用内置的数据库迁移清单无效。",
        "请重新安装 OMP Manager；现有数据库未被修改。",
        false,
        "stage=validate_manifest",
    ))
}

fn verify_database_integrity(connection: &Connection) -> Result<(), DomainError> {
    let result: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| {
            migration_error(
                "integrity_check",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;

    if result.eq_ignore_ascii_case("ok") {
        return Ok(());
    }

    Err(DomainError::new(
        "database_integrity_failed",
        "OMP Manager 元数据数据库未通过完整性检查。",
        "请保留数据库文件并从最近的迁移备份恢复，或联系支持人员。",
        false,
        "stage=integrity_check; result=not_ok",
    ))
}

fn verify_foreign_key_integrity(connection: &Connection) -> Result<(), DomainError> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| {
            migration_error(
                "foreign_key_check",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;
    let has_violation = statement.exists([]).map_err(|error| {
        migration_error(
            "foreign_key_check",
            None,
            false,
            sqlite_error_is_retryable(&error),
            &sqlite_error_detail(&error),
        )
    })?;

    if !has_violation {
        return Ok(());
    }

    Err(DomainError::new(
        "database_foreign_key_integrity_failed",
        "OMP Manager 元数据数据库包含无效的关联记录。",
        "请保留数据库和备份，不要继续写入，并联系支持人员。",
        false,
        "stage=foreign_key_check; result=violation",
    ))
}

fn load_applied_versions(connection: &Connection) -> Result<Vec<u32>, DomainError> {
    let table_exists: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM sqlite_schema
                WHERE type = 'table' AND name = 'schema_migrations'
            )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            migration_error(
                "read_history",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;

    if !table_exists {
        return Ok(Vec::new());
    }

    let mut statement = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .map_err(|error| {
            migration_error(
                "read_history",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;
    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| {
            migration_error(
                "read_history",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;

    let mut versions = Vec::new();
    for row in rows {
        let version = row.map_err(|error| {
            migration_error(
                "read_history",
                None,
                false,
                sqlite_error_is_retryable(&error),
                &sqlite_error_detail(&error),
            )
        })?;
        let version = u32::try_from(version).map_err(|_| {
            DomainError::new(
                "database_migration_history_invalid",
                "数据库迁移历史包含无效版本。",
                "请保留数据库和备份，不要继续写入，并联系支持人员。",
                false,
                "stage=read_history; version=out_of_range",
            )
        })?;
        versions.push(version);
    }

    Ok(versions)
}

fn validate_applied_prefix(applied: &[u32], migrations: &[Migration]) -> Result<(), DomainError> {
    let newest_known = migrations.last().map(|migration| migration.version);
    if applied.len() > migrations.len()
        || applied
            .last()
            .is_some_and(|version| Some(*version) > newest_known)
    {
        return Err(DomainError::new(
            "database_schema_newer_than_application",
            "数据库由更高版本的 OMP Manager 创建。",
            "请升级应用；当前版本不会修改该数据库。",
            false,
            "stage=validate_history; database_version=newer",
        ));
    }

    let is_prefix = applied
        .iter()
        .zip(migrations)
        .all(|(applied_version, migration)| *applied_version == migration.version);
    if is_prefix {
        return Ok(());
    }

    Err(DomainError::new(
        "database_migration_history_invalid",
        "数据库迁移历史不连续或无法识别。",
        "请保留数据库和备份，不要继续写入，并联系支持人员。",
        false,
        "stage=validate_history; history=non_contiguous",
    ))
}

fn create_consistent_backup(
    database_path: &Path,
    expected_identity: &DatabaseFileIdentity,
) -> Result<PathBuf, DomainError> {
    verify_database_identity(database_path, expected_identity, "before_backup_open")?;
    let (reserved_file, partial_path, final_path, partial_identity) =
        reserve_backup_paths(database_path)?;
    let backup_result = populate_backup(
        database_path,
        expected_identity,
        &reserved_file,
        &partial_path,
        &partial_identity,
        &final_path,
    );
    drop(reserved_file);

    if let Err(error) = backup_result {
        let _ = fs::remove_file(&partial_path);
        return Err(error);
    }

    let _ = fs::remove_file(&partial_path);
    sync_parent_directory(&final_path).map_err(|error| {
        backup_error(
            "sync_backup_directory",
            &format!("io_kind={:?}", error.kind()),
        )
    })?;

    Ok(final_path)
}

fn populate_backup(
    database_path: &Path,
    expected_identity: &DatabaseFileIdentity,
    reserved_file: &File,
    partial_path: &Path,
    partial_identity: &DatabaseFileIdentity,
    final_path: &Path,
) -> Result<(), DomainError> {
    let source = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| backup_error("open_backup_source", &sqlite_error_detail(&error)))?;
    verify_database_identity(database_path, expected_identity, "after_backup_source_open")?;

    let mut destination = Connection::open_with_flags(
        partial_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| backup_error("open_backup_destination", &sqlite_error_detail(&error)))?;
    verify_database_identity(
        partial_path,
        partial_identity,
        "after_backup_destination_open",
    )?;

    copy_database(&source, &mut destination)?;
    drop(destination);

    verify_database_identity(database_path, expected_identity, "after_backup_copy")?;
    let populated_identity =
        read_database_handle_identity(reserved_file, "backup_destination_handle")?;
    verify_database_identity(partial_path, &populated_identity, "after_backup_copy")?;
    reserved_file
        .sync_all()
        .map_err(|error| backup_error("sync_backup_file", &io_error_detail(&error)))?;

    fs::hard_link(partial_path, final_path)
        .map_err(|error| backup_error("publish_backup", &io_error_detail(&error)))?;
    if let Err(error) = verify_database_identity(final_path, &populated_identity, "publish_backup")
    {
        let _ = fs::remove_file(final_path);
        return Err(error);
    }

    Ok(())
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<(), DomainError> {
    let backup = Backup::new(source, destination)
        .map_err(|error| backup_error("initialize_backup", &sqlite_error_detail(&error)))?;
    let deadline = Instant::now() + BACKUP_TIMEOUT;

    loop {
        let step = backup
            .step(128)
            .map_err(|error| backup_error("copy_backup", &sqlite_error_detail(&error)))?;
        if step != StepResult::Done && Instant::now() >= deadline {
            return Err(backup_error(
                "copy_backup",
                "result=timeout; timeout_ms=30000",
            ));
        }
        match step {
            StepResult::Done => return Ok(()),
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => {
                thread::sleep(BACKUP_RETRY_DELAY);
            }
            _ => {
                return Err(backup_error("copy_backup", "result=unknown_step"));
            }
        }
    }
}

fn reserve_backup_paths(
    database_path: &Path,
) -> Result<(File, PathBuf, PathBuf, DatabaseFileIdentity), DomainError> {
    let parent = database_path.parent().ok_or_else(|| {
        DomainError::new(
            "database_path_invalid",
            "数据库路径缺少有效的父目录。",
            "重新启动应用；若问题持续，请检查应用数据目录配置。",
            false,
            "stage=backup_path; parent=missing",
        )
    })?;
    let database_name = database_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("metadata.sqlite3");
    let timestamp = now_epoch_ms()?;
    let process_id = std::process::id();

    for attempt in 0_u16..1_000 {
        let final_path = parent.join(format!(
            "{database_name}.pre-migration-{timestamp}-{process_id}-{attempt}.bak"
        ));
        if final_path.exists() {
            continue;
        }

        let partial_path = final_path.with_extension("bak.partial");
        match create_private_file(&partial_path) {
            Ok(file) => {
                let identity = match read_database_identity(&partial_path) {
                    Ok(identity) => identity,
                    Err(error) => {
                        drop(file);
                        let _ = fs::remove_file(&partial_path);
                        return Err(error);
                    }
                };
                return Ok((file, partial_path, final_path, identity));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(DomainError::new(
                    "database_backup_failed",
                    "升级前无法准备数据库备份文件。",
                    "确认应用数据目录可写且磁盘空间充足后重试；数据库未迁移。",
                    true,
                    format!("stage=reserve_backup; {}", io_error_detail(&error)),
                ));
            }
        }
    }

    Err(DomainError::new(
        "database_backup_name_exhausted",
        "无法为迁移备份分配安全文件名。",
        "清理应用数据目录中过期的临时备份后重试。",
        true,
        "stage=reserve_backup; attempts=1000",
    ))
}

fn backup_error(stage: &str, detail: &str) -> DomainError {
    DomainError::new(
        "database_backup_failed",
        "升级前无法创建一致的数据库备份。",
        "确认应用数据目录可写、支持文件锁与硬链接且磁盘空间充足后重试；数据库未迁移。",
        true,
        format!("stage={stage}; {detail}"),
    )
}

fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    options.open(path)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent"))?;
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn now_epoch_ms() -> Result<i64, DomainError> {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
        DomainError::new(
            "system_clock_invalid",
            "系统时间早于 Unix 纪元，无法记录数据库迁移。",
            "修正系统时间后重试。",
            true,
            "stage=timestamp; clock=before_epoch",
        )
    })?;

    i64::try_from(duration.as_millis()).map_err(|_| {
        DomainError::new(
            "system_clock_invalid",
            "系统时间超出数据库可记录范围。",
            "修正系统时间后重试。",
            true,
            "stage=timestamp; milliseconds=out_of_range",
        )
    })
}

fn attach_backup<T>(
    result: Result<T, DomainError>,
    backup_path: &Option<PathBuf>,
) -> Result<T, DatabaseOpenError> {
    result.map_err(|error| DatabaseOpenError::new(error, backup_path.clone()))
}

fn sqlite_error_is_retryable(error: &rusqlite::Error) -> bool {
    let rusqlite::Error::SqliteFailure(error, _) = error else {
        return false;
    };

    matches!(
        error.code,
        rusqlite::ErrorCode::PermissionDenied
            | rusqlite::ErrorCode::DatabaseBusy
            | rusqlite::ErrorCode::DatabaseLocked
            | rusqlite::ErrorCode::ReadOnly
            | rusqlite::ErrorCode::OperationInterrupted
            | rusqlite::ErrorCode::SystemIoFailure
            | rusqlite::ErrorCode::DiskFull
            | rusqlite::ErrorCode::CannotOpen
            | rusqlite::ErrorCode::FileLockingProtocolFailed
            | rusqlite::ErrorCode::SchemaChanged
    )
}

fn migration_error(
    stage: &str,
    migration: Option<&Migration>,
    backup_created: bool,
    retryable: bool,
    error_detail: &str,
) -> DomainError {
    let migration_detail = migration
        .map(|migration| format!("{}:{}", migration.version, migration.name))
        .unwrap_or_else(|| "none".to_owned());
    let suggestion = if backup_created && !retryable {
        "旧数据库已保留为一致备份；先修复诊断中的确定性问题或替换数据库，再重试。"
    } else if backup_created {
        "旧数据库已保留为一致备份；确认磁盘与目录权限后重试。"
    } else {
        "确认应用数据目录可写且数据库未被其他进程长期占用后重试。"
    };

    DomainError::new(
        "database_migration_failed",
        "OMP Manager 元数据数据库升级失败。",
        suggestion,
        retryable,
        format!(
            "stage={stage}; migration={migration_detail}; backup_created={backup_created}; {error_detail}"
        ),
    )
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::*;
    use crate::infrastructure::db::{configure_connection, read_database_identity};

    #[test]
    fn a_failed_migration_rolls_back_and_keeps_the_backup() {
        let directory = tempdir().expect("tempdir");
        let database_path = directory.path().join("metadata.sqlite3");
        let mut connection = Connection::open(&database_path).expect("open");
        configure_connection(&connection).expect("configure");
        connection
            .execute_batch(MIGRATIONS[0].sql)
            .expect("create version one schema");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, applied_at_epoch_ms) VALUES (1, 1)",
                [],
            )
            .expect("record version one");
        let identity = read_database_identity(&database_path).expect("database identity");

        let invalid_migrations = [
            MIGRATIONS[0],
            Migration {
                version: 2,
                name: "intentionally_invalid",
                sql: "CREATE TABLE should_roll_back (id INTEGER); THIS IS NOT SQL;",
            },
        ];
        let error = run_migrations(
            &mut connection,
            &database_path,
            true,
            &identity,
            &invalid_migrations,
        )
        .expect_err("invalid migration must fail");

        assert_eq!(error.code, "database_migration_failed");
        assert!(error
            .technical_detail_redacted
            .contains("backup_created=true"));

        let migration_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration count");
        assert_eq!(migration_count, 1);

        let rolled_back_table: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_schema
                    WHERE type = 'table' AND name = 'should_roll_back'
                )",
                [],
                |row| row.get(0),
            )
            .expect("table lookup");
        assert!(!rolled_back_table);

        let backups = fs::read_dir(directory.path())
            .expect("read database directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".pre-migration-")
                    && entry.path().extension().is_some_and(|value| value == "bak")
            })
            .count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn rejects_non_contiguous_migration_history() {
        let error =
            validate_applied_prefix(&[2], MIGRATIONS).expect_err("history must be a prefix");
        assert_eq!(error.code, "database_migration_history_invalid");
    }

    #[test]
    fn rejects_a_database_from_a_newer_application() {
        let error = validate_applied_prefix(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], MIGRATIONS)
            .expect_err("newer schema must be refused");
        assert_eq!(error.code, "database_schema_newer_than_application");
    }

    #[test]
    fn profile_key_migration_preserves_session_annotations() {
        let directory = tempdir().expect("tempdir");
        let database_path = directory.path().join("metadata.sqlite3");
        let mut connection = Connection::open(&database_path).expect("open");
        configure_connection(&connection).expect("configure");
        for migration in &MIGRATIONS[..8] {
            connection
                .execute_batch(migration.sql)
                .expect("apply historical migration");
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, applied_at_epoch_ms)
                     VALUES (?1, ?2)",
                    [i64::from(migration.version), i64::from(migration.version)],
                )
                .expect("record historical migration");
        }
        connection
            .execute(
                "INSERT INTO session_index (
                    target_id, profile, session_path, session_id, cwd, title,
                    modified_at_epoch_ms, status, fingerprint
                 ) VALUES ('local', 'first', '/same/session.jsonl', 'one', '/tmp', '', 1, 'unknown', 'one')",
                [],
            )
            .expect("historical session");
        let first_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO session_annotations (
                    session_index_id, target_id, favorite, tags_json, updated_at_epoch_ms
                 ) VALUES (?1, 'local', 1, '[]', 1)",
                [first_id],
            )
            .expect("historical annotation");
        let identity = read_database_identity(&database_path).expect("identity");

        let outcome = run_migrations(&mut connection, &database_path, true, &identity, MIGRATIONS)
            .expect("upgrade");
        assert_eq!(outcome.applied_versions, [9]);
        connection
            .execute(
                "INSERT INTO session_index (
                    target_id, profile, session_path, session_id, cwd, title,
                    modified_at_epoch_ms, status, fingerprint
                 ) VALUES ('local', 'second', '/same/session.jsonl', 'two', '/tmp', '', 2, 'unknown', 'two')",
                [],
            )
            .expect("same path under another profile");
        let favorite: i64 = connection
            .query_row(
                "SELECT favorite FROM session_annotations WHERE session_index_id = ?1",
                [first_id],
                |row| row.get(0),
            )
            .expect("preserved annotation");
        let foreign_key_violations: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check");
        assert_eq!(favorite, 1);
        assert_eq!(foreign_key_violations, 0);
    }
}
