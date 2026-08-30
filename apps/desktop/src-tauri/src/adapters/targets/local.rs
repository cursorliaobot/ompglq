#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Stdio;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::Duration;

use async_trait::async_trait;

use serde_json::json;

use super::{
    AllowedFileRead, AllowedJsonlListing, AllowedJsonlListingRequest, AllowedReadRequest,
    CanonicalDirectory, ExecutionTarget, ExternalTerminalProcess, GitIdentity, TargetHealth,
};
use crate::domain::{DomainError, ExecutableIdentityEvidence, LaunchPlan, PtySpikeReport};
use crate::infrastructure::process::{
    open_verified_executable, resolve_executable_on_path, OmpJsonOutput, OmpProbeCommand,
    OmpProcessOutput, OpenedExecutable, ProcessRunner,
};
use crate::infrastructure::pty::run_fixed_pty_spike;
use crate::infrastructure::secrets::redact;

#[cfg(target_os = "linux")]
const MAXIMUM_EXTERNAL_EXECUTABLE_LEASES: usize = 16;
#[cfg(target_os = "linux")]
const EXTERNAL_EXECUTABLE_LEASE: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct LocalTarget {
    runner: ProcessRunner,
    #[cfg(target_os = "linux")]
    external_executable_leases: Arc<Mutex<HashMap<u64, OpenedExecutable>>>,
    #[cfg(target_os = "linux")]
    next_external_lease_id: Arc<AtomicU64>,
}

impl std::fmt::Debug for LocalTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalTarget")
            .finish_non_exhaustive()
    }
}

impl Default for LocalTarget {
    fn default() -> Self {
        Self::new(ProcessRunner::default())
    }
}

impl LocalTarget {
    pub fn new(runner: ProcessRunner) -> Self {
        Self {
            runner,
            #[cfg(target_os = "linux")]
            external_executable_leases: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(target_os = "linux")]
            next_external_lease_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

#[async_trait]
impl ExecutionTarget for LocalTarget {
    fn target_id(&self) -> &str {
        "local"
    }

    async fn probe(&self) -> Result<TargetHealth, DomainError> {
        self.health_check().await
    }

    async fn canonicalize_path(&self, path: &Path) -> Result<PathBuf, DomainError> {
        let path = path.to_owned();
        let task_path = path.clone();
        tokio::task::spawn_blocking(move || std::fs::canonicalize(&task_path))
            .await
            .map_err(|error| {
                DomainError::new(
                    "path_task_failed",
                    "规范化本机路径时失败。",
                    "重新选择路径后重试。",
                    true,
                    redact(&error.to_string()),
                )
            })?
            .map_err(|error| {
                DomainError::new(
                    "path_canonicalize_failed",
                    "无法访问所选路径。",
                    "确认路径存在且当前用户有权访问。",
                    true,
                    redact(&format!("path={} error={error}", path.display())),
                )
            })
    }

    async fn authorize_directory(&self, path: &Path) -> Result<CanonicalDirectory, DomainError> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || inspect_authorized_directory(&path))
            .await
            .map_err(|error| {
                DomainError::new(
                    "path_authorization_task_failed",
                    "项目目录授权任务异常结束。",
                    "重新选择项目目录后重试。",
                    true,
                    redact(&error.to_string()),
                )
            })?
    }

    async fn authorize_session_directory(
        &self,
        path: &Path,
    ) -> Result<CanonicalDirectory, DomainError> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || inspect_authorized_session_directory(&path))
            .await
            .map_err(|error| {
                DomainError::new(
                    "session_path_authorization_task_failed",
                    "会话目录授权任务异常结束。",
                    "重新选择 OMP sessions 目录后重试。",
                    true,
                    redact(&error.to_string()),
                )
            })?
    }

    async fn resolve_git_identity(&self, path: &Path) -> Result<Option<GitIdentity>, DomainError> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || resolve_local_git_identity(&path))
            .await
            .map_err(|error| {
                DomainError::new(
                    "git_identity_task_failed",
                    "Git 项目标识任务异常结束。",
                    "项目仍可稍后重新添加；若问题持续，请检查目录权限。",
                    true,
                    redact(&error.to_string()),
                )
            })?
    }

    async fn run_omp(
        &self,
        executable: &Path,
        expected_identity: &ExecutableIdentityEvidence,
        command: OmpProbeCommand,
    ) -> Result<OmpProcessOutput, DomainError> {
        self.runner
            .run_omp(executable, expected_identity, command)
            .await
    }

    async fn run_omp_models_json(
        &self,
        executable: &Path,
        expected_identity: &ExecutableIdentityEvidence,
        profile: &str,
        project: &Path,
    ) -> Result<OmpJsonOutput, DomainError> {
        self.runner
            .run_omp_models_json(executable, expected_identity, profile, project)
            .await
    }

    async fn read_allowed_file(
        &self,
        request: AllowedReadRequest,
    ) -> Result<AllowedFileRead, DomainError> {
        tokio::task::spawn_blocking(move || read_allowed_local_file(request))
            .await
            .map_err(|error| {
                DomainError::new(
                    "allowed_file_read_task_failed",
                    "受控文件读取任务异常结束。",
                    "重新扫描；若问题持续，请重新启动应用。",
                    true,
                    redact(&error.to_string()),
                )
            })?
    }

    async fn list_allowed_jsonl_files(
        &self,
        request: AllowedJsonlListingRequest,
    ) -> Result<AllowedJsonlListing, DomainError> {
        tokio::task::spawn_blocking(move || list_allowed_jsonl_files(request))
            .await
            .map_err(|error| {
                DomainError::new(
                    "allowed_file_list_task_failed",
                    "会话文件列举任务异常结束。",
                    "重新扫描；若问题持续，请重新启动应用。",
                    true,
                    redact(&error.to_string()),
                )
            })?
    }

    async fn spawn_pty(&self) -> Result<PtySpikeReport, DomainError> {
        tokio::task::spawn_blocking(run_fixed_pty_spike)
            .await
            .map_err(|error| {
                DomainError::new(
                    "pty_task_failed",
                    "PTY 自检任务异常结束。",
                    "可重试；若仍失败，请使用外部终端。",
                    true,
                    redact(&error.to_string()),
                )
            })?
    }

    async fn open_external_terminal(
        &self,
        plan: &LaunchPlan,
        expected_identity: &ExecutableIdentityEvidence,
    ) -> Result<ExternalTerminalProcess, DomainError> {
        #[cfg(target_os = "linux")]
        {
            return self
                .open_linux_external_terminal(plan, expected_identity)
                .await;
        }
        #[cfg(target_os = "windows")]
        {
            return open_windows_external_terminal(plan, expected_identity).await;
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = (plan, expected_identity);
            Err(external_terminal_error(
                "external_terminal_platform_unsupported",
                "当前平台尚不支持外部终端。",
                "改用内嵌终端。",
                false,
                "the local target has no external terminal adapter for this platform",
            ))
        }
    }

    async fn health_check(&self) -> Result<TargetHealth, DomainError> {
        Ok(TargetHealth {
            target_id: self.target_id().to_owned(),
            healthy: true,
            diagnostics: Vec::new(),
        })
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum LinuxTerminalProtocol {
    Xfce,
    Gnome,
    Konsole,
    Kitty,
    Alacritty,
    WezTerm,
    Foot,
    Xterm,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
struct LinuxTerminalCandidate {
    id: &'static str,
    executable: &'static str,
    protocol: LinuxTerminalProtocol,
}

#[cfg(target_os = "linux")]
const LINUX_TERMINAL_CANDIDATES: &[LinuxTerminalCandidate] = &[
    LinuxTerminalCandidate {
        id: "xfce4-terminal",
        executable: "xfce4-terminal",
        protocol: LinuxTerminalProtocol::Xfce,
    },
    LinuxTerminalCandidate {
        id: "gnome-terminal",
        executable: "gnome-terminal",
        protocol: LinuxTerminalProtocol::Gnome,
    },
    LinuxTerminalCandidate {
        id: "konsole",
        executable: "konsole",
        protocol: LinuxTerminalProtocol::Konsole,
    },
    LinuxTerminalCandidate {
        id: "kitty",
        executable: "kitty",
        protocol: LinuxTerminalProtocol::Kitty,
    },
    LinuxTerminalCandidate {
        id: "alacritty",
        executable: "alacritty",
        protocol: LinuxTerminalProtocol::Alacritty,
    },
    LinuxTerminalCandidate {
        id: "wezterm",
        executable: "wezterm",
        protocol: LinuxTerminalProtocol::WezTerm,
    },
    LinuxTerminalCandidate {
        id: "foot",
        executable: "foot",
        protocol: LinuxTerminalProtocol::Foot,
    },
    LinuxTerminalCandidate {
        id: "xterm",
        executable: "xterm",
        protocol: LinuxTerminalProtocol::Xterm,
    },
];

#[cfg(target_os = "linux")]
impl LocalTarget {
    async fn open_linux_external_terminal(
        &self,
        plan: &LaunchPlan,
        expected_identity: &ExecutableIdentityEvidence,
    ) -> Result<ExternalTerminalProcess, DomainError> {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err(external_terminal_error(
                "external_terminal_session_unavailable",
                "当前进程没有可用的图形桌面会话。",
                "从 Linux 桌面启动 OMP Manager，或改用内嵌终端。",
                true,
                "stage=desktop_session display=absent wayland_display=absent",
            ));
        }
        let omp = open_verified_executable(plan.omp_executable()).map_err(|error| {
            external_terminal_error(
                "external_terminal_omp_unavailable",
                "无法为外部终端固定当前 OMP 可执行文件。",
                "重新检测 OMP 后再试，或改用内嵌终端。",
                true,
                &format!("stage=open_omp error={}", redact(&error.to_string())),
            )
        })?;
        if omp.evidence() != expected_identity {
            return Err(external_terminal_error(
                "external_terminal_omp_changed",
                "OMP 可执行文件在外部终端启动前发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "stage=verify_omp identity=mismatch",
            ));
        }

        let (candidate, terminal) = select_linux_terminal()?;
        let command_path = omp.parent_command_path();
        let command_prefix = omp.parent_command_arguments();
        let arguments = linux_terminal_arguments(
            candidate.protocol,
            plan.cwd(),
            &command_path,
            &command_prefix,
            plan.args(),
        );

        let lease_id = self.next_external_lease_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut leases = self.external_executable_leases.lock().map_err(|_| {
                external_terminal_error(
                    "external_terminal_lease_unavailable",
                    "外部终端启动资源暂不可用。",
                    "稍后重试，或改用内嵌终端。",
                    true,
                    "stage=lease_registry state=poisoned",
                )
            })?;
            if leases.len() >= MAXIMUM_EXTERNAL_EXECUTABLE_LEASES {
                return Err(external_terminal_error(
                    "external_terminal_launch_busy",
                    "正在启动的外部终端数量已达到安全上限。",
                    "等待已有外部终端完成启动后重试。",
                    true,
                    "stage=lease_registry capacity=exhausted",
                ));
            }
            leases.insert(lease_id, omp);
        }

        let mut command = tokio::process::Command::new(terminal.command_path());
        terminal.configure_tokio_command(&mut command);
        command
            .args(arguments)
            .current_dir(plan.cwd())
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        apply_launch_environment(&mut command, plan.env_allowlist());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.remove_external_lease(lease_id);
                return Err(external_terminal_error(
                    "external_terminal_spawn_failed",
                    "外部终端未能启动。",
                    "检查桌面会话后重试，或改用内嵌终端。",
                    true,
                    &format!(
                        "stage=spawn terminal={} error={}",
                        candidate.id,
                        redact(&error.to_string())
                    ),
                ));
            }
        };
        let process_id = child.id();
        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        let leases = Arc::clone(&self.external_executable_leases);
        tokio::spawn(async move {
            tokio::time::sleep(EXTERNAL_EXECUTABLE_LEASE).await;
            if let Ok(mut leases) = leases.lock() {
                leases.remove(&lease_id);
            }
        });

        Ok(ExternalTerminalProcess {
            terminal_id: candidate.id.to_owned(),
            process_id,
        })
    }

    fn remove_external_lease(&self, lease_id: u64) {
        if let Ok(mut leases) = self.external_executable_leases.lock() {
            leases.remove(&lease_id);
        }
    }
}

#[cfg(target_os = "linux")]
fn select_linux_terminal() -> Result<(LinuxTerminalCandidate, OpenedExecutable), DomainError> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let preferred = if desktop.contains("xfce") {
        Some("xfce4-terminal")
    } else if desktop.contains("gnome") {
        Some("gnome-terminal")
    } else if desktop.contains("kde") || desktop.contains("plasma") {
        Some("konsole")
    } else {
        None
    };
    let candidates = preferred.into_iter().chain(
        LINUX_TERMINAL_CANDIDATES
            .iter()
            .map(|candidate| candidate.id),
    );

    for id in candidates {
        let Some(candidate) = LINUX_TERMINAL_CANDIDATES
            .iter()
            .find(|candidate| candidate.id == id)
            .copied()
        else {
            continue;
        };
        let Some(path) = resolve_executable_on_path(candidate.executable) else {
            continue;
        };
        let Ok(path) = std::fs::canonicalize(path) else {
            continue;
        };
        if let Ok(terminal) = open_verified_executable(&path) {
            return Ok((candidate, terminal));
        }
    }

    Err(external_terminal_error(
        "external_terminal_not_found",
        "未检测到受支持的 Linux 外部终端。",
        "安装 XFCE Terminal、GNOME Terminal、Konsole、Kitty、Alacritty、WezTerm、Foot 或 XTerm，或改用内嵌终端。",
        true,
        "stage=terminal_probe result=no_verified_candidate",
    ))
}

#[cfg(target_os = "linux")]
fn linux_terminal_arguments(
    protocol: LinuxTerminalProtocol,
    cwd: &Path,
    command: &Path,
    command_prefix: &[PathBuf],
    arguments: &[String],
) -> Vec<OsString> {
    let mut result = Vec::new();
    match protocol {
        LinuxTerminalProtocol::Xfce => {
            result.extend([
                OsString::from("--disable-server"),
                prefixed_os_string("--working-directory=", cwd.as_os_str()),
                OsString::from("--title=OMP Manager"),
                OsString::from("--execute"),
            ]);
        }
        LinuxTerminalProtocol::Gnome => {
            result.extend([
                OsString::from("--wait"),
                prefixed_os_string("--working-directory=", cwd.as_os_str()),
                OsString::from("--title=OMP Manager"),
                OsString::from("--"),
            ]);
        }
        LinuxTerminalProtocol::Konsole => {
            result.extend([
                OsString::from("--separate"),
                OsString::from("--workdir"),
                cwd.as_os_str().to_owned(),
                OsString::from("-p"),
                OsString::from("tabtitle=OMP Manager"),
                OsString::from("-e"),
            ]);
        }
        LinuxTerminalProtocol::Kitty => {
            result.extend([
                OsString::from("--directory"),
                cwd.as_os_str().to_owned(),
                OsString::from("--title"),
                OsString::from("OMP Manager"),
                OsString::from("--"),
            ]);
        }
        LinuxTerminalProtocol::Alacritty => {
            result.extend([
                OsString::from("--working-directory"),
                cwd.as_os_str().to_owned(),
                OsString::from("--title"),
                OsString::from("OMP Manager"),
                OsString::from("-e"),
            ]);
        }
        LinuxTerminalProtocol::WezTerm => {
            result.extend([
                OsString::from("start"),
                OsString::from("--cwd"),
                cwd.as_os_str().to_owned(),
                OsString::from("--"),
            ]);
        }
        LinuxTerminalProtocol::Foot => {
            result.extend([
                prefixed_os_string("--working-directory=", cwd.as_os_str()),
                OsString::from("--title=OMP Manager"),
                OsString::from("--"),
            ]);
        }
        LinuxTerminalProtocol::Xterm => {
            result.extend([
                OsString::from("-T"),
                OsString::from("OMP Manager"),
                OsString::from("-e"),
            ]);
        }
    }
    result.push(command.as_os_str().to_owned());
    result.extend(
        command_prefix
            .iter()
            .map(|argument| argument.as_os_str().to_owned()),
    );
    result.extend(arguments.iter().map(OsString::from));
    result
}

#[cfg(target_os = "linux")]
fn prefixed_os_string(prefix: &str, value: &std::ffi::OsStr) -> OsString {
    let mut result = OsString::from(prefix);
    result.push(value);
    result
}

#[cfg(target_os = "linux")]
fn apply_launch_environment(command: &mut tokio::process::Command, allowlist: &[String]) {
    for name in allowlist {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

#[cfg(target_os = "windows")]
async fn open_windows_external_terminal(
    plan: &LaunchPlan,
    expected_identity: &ExecutableIdentityEvidence,
) -> Result<ExternalTerminalProcess, DomainError> {
    use std::os::windows::process::CommandExt as _;

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    let omp = open_verified_executable(plan.omp_executable()).map_err(|error| {
        external_terminal_error(
            "external_terminal_omp_unavailable",
            "无法为外部终端固定当前 OMP 可执行文件。",
            "重新检测 OMP 后再试，或改用内嵌终端。",
            true,
            &format!("stage=open_omp error={}", redact(&error.to_string())),
        )
    })?;
    if omp.evidence() != expected_identity {
        return Err(external_terminal_error(
            "external_terminal_omp_changed",
            "OMP 可执行文件在外部终端启动前发生变化。",
            "重新检测 OMP 并生成新的启动预览。",
            true,
            "stage=verify_omp identity=mismatch",
        ));
    }

    let (terminal_id, mut command) = if let Some(path) = resolve_executable_on_path("wt") {
        let terminal = open_verified_executable(&path).map_err(|error| {
            external_terminal_error(
                "external_terminal_probe_failed",
                "检测到 Windows Terminal，但无法安全打开它。",
                "修复 Windows Terminal，或改用内嵌终端。",
                true,
                &format!(
                    "stage=open_windows_terminal error={}",
                    redact(&error.to_string())
                ),
            )
        })?;
        let mut command = tokio::process::Command::new(terminal.command_path());
        terminal.configure_tokio_command(&mut command);
        command
            .arg("-w")
            .arg("new")
            .arg("new-tab")
            .arg("--inheritEnvironment")
            .arg("-d")
            .arg(plan.cwd())
            .arg("--title")
            .arg("OMP Manager")
            .arg("--")
            .arg(omp.command_path())
            .args(omp.command_arguments())
            .args(plan.args());
        ("windows-terminal", command)
    } else {
        let mut command = tokio::process::Command::new(omp.command_path());
        omp.configure_tokio_command(&mut command);
        command.args(omp.command_arguments()).args(plan.args());
        command.as_std_mut().creation_flags(CREATE_NEW_CONSOLE);
        ("windows-console", command)
    };
    command
        .current_dir(plan.cwd())
        .env_clear()
        .kill_on_drop(false);
    for name in plan.env_allowlist() {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        external_terminal_error(
            "external_terminal_spawn_failed",
            "外部终端未能启动。",
            "检查桌面会话后重试，或改用内嵌终端。",
            true,
            &format!(
                "stage=spawn terminal={terminal_id} error={}",
                redact(&error.to_string())
            ),
        )
    })?;
    let process_id = child.id();
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(ExternalTerminalProcess {
        terminal_id: terminal_id.to_owned(),
        process_id,
    })
}

fn external_terminal_error(
    code: &'static str,
    message: &'static str,
    suggestion: &'static str,
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

#[cfg(target_os = "linux")]
fn list_allowed_jsonl_files(
    request: AllowedJsonlListingRequest,
) -> Result<AllowedJsonlListing, DomainError> {
    list_allowed_jsonl_files_anchored(request)
}

#[cfg(not(target_os = "linux"))]
fn list_allowed_jsonl_files(
    request: AllowedJsonlListingRequest,
) -> Result<AllowedJsonlListing, DomainError> {
    let _ = request;
    Err(project_path_error(
        "session_file_identity_unverified",
        "当前平台尚未实现基于目录句柄的会话列举。",
        "等待平台文件身份验证完成后重试。",
        false,
        "stage=session_listing; platform=unverified",
    ))
}

#[cfg(any())]
fn list_allowed_jsonl_files_legacy_uncompiled(
    request: AllowedJsonlListingRequest,
) -> Result<AllowedJsonlListing, DomainError> {
    #[cfg(target_os = "linux")]
    {
        return list_allowed_jsonl_files_anchored(request);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = request;
        return Err(project_path_error(
            "session_file_identity_unverified",
            "当前平台尚未实现基于目录句柄的会话列举。",
            "等待平台文件身份验证完成后重试。",
            false,
            "stage=session_listing; platform=unverified",
        ));
    }
    #[cfg(any())]
    {
        if request.maximum_entries == 0
            || request.maximum_directories == 0
            || request.maximum_files == 0
        {
            return Err(project_path_error(
                "session_listing_limits_invalid",
                "会话目录列举限制无效。",
                "恢复默认扫描限制后重试。",
                false,
                "stage=session_listing; limits=invalid",
            ));
        }
        let root = canonical_directory_root(&request.authorized_root)?;
        let mut files = Vec::new();
        let mut entry_count = 0_usize;
        let mut directory_count = 0_usize;
        let mut skipped_entry_count = 0_u64;

        let entries = fs::read_dir(&root).map_err(|error| {
            project_path_io_error(
                "session_root_unavailable",
                "无法读取已授权的会话根目录。",
                "确认目录和权限仍然有效后重试。",
                true,
                "read_session_root",
                &error,
            )
        })?;
        for entry in entries {
            entry_count = entry_count.saturating_add(1);
            enforce_session_entry_limit(entry_count, request.maximum_entries)?;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    skipped_entry_count = skipped_entry_count.saturating_add(1);
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    skipped_entry_count = skipped_entry_count.saturating_add(1);
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                skipped_entry_count = skipped_entry_count.saturating_add(1);
                continue;
            }
            if metadata.is_file() {
                collect_jsonl_file(
                    path,
                    &mut files,
                    request.maximum_files,
                    &mut skipped_entry_count,
                )?;
                continue;
            }
            if !metadata.is_dir() {
                continue;
            }
            directory_count = directory_count.saturating_add(1);
            if directory_count > request.maximum_directories {
                return Err(project_path_error(
                    "session_directory_limit_exceeded",
                    "会话根目录中的项目目录数量超过扫描上限。",
                    "缩小授权范围或提高受控限制后重试。",
                    false,
                    "stage=session_listing; directories=too_many",
                ));
            }
            let child_entries = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => {
                    skipped_entry_count = skipped_entry_count.saturating_add(1);
                    continue;
                }
            };
            for child in child_entries {
                entry_count = entry_count.saturating_add(1);
                enforce_session_entry_limit(entry_count, request.maximum_entries)?;
                let child = match child {
                    Ok(child) => child,
                    Err(_) => {
                        skipped_entry_count = skipped_entry_count.saturating_add(1);
                        continue;
                    }
                };
                let child_path = child.path();
                let child_metadata = match fs::symlink_metadata(&child_path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        skipped_entry_count = skipped_entry_count.saturating_add(1);
                        continue;
                    }
                };
                if child_metadata.file_type().is_symlink() {
                    skipped_entry_count = skipped_entry_count.saturating_add(1);
                    continue;
                }
                if child_metadata.is_file() {
                    collect_jsonl_file(
                        child_path,
                        &mut files,
                        request.maximum_files,
                        &mut skipped_entry_count,
                    )?;
                }
            }
        }
        files.sort();
        Ok(AllowedJsonlListing {
            files,
            skipped_entry_count,
        })
    }
}

#[cfg(target_os = "linux")]
fn list_allowed_jsonl_files_anchored(
    request: AllowedJsonlListingRequest,
) -> Result<AllowedJsonlListing, DomainError> {
    use std::os::fd::AsRawFd;

    if request.maximum_entries == 0
        || request.maximum_directories == 0
        || request.maximum_files == 0
    {
        return Err(project_path_error(
            "session_listing_limits_invalid",
            "会话目录列举限制无效。",
            "恢复默认扫描限制后重试。",
            false,
            "stage=session_listing; limits=invalid",
        ));
    }
    let root = open_verified_session_root(
        &request.authorized_root,
        &request.expected_root_identity_json,
    )?;
    let mut files = Vec::new();
    let mut entry_count = 0_usize;
    let mut directory_count = 0_usize;
    let mut skipped_entry_count = 0_u64;
    let entries = fs::read_dir(fd_directory_path(root.as_raw_fd())).map_err(|error| {
        project_path_io_error(
            "session_root_unavailable",
            "无法从已验证句柄读取会话根目录。",
            "重新授权 OMP sessions 目录。",
            true,
            "read_session_root_handle",
            &error,
        )
    })?;
    for entry in entries {
        entry_count = entry_count.saturating_add(1);
        enforce_session_entry_limit(entry_count, request.maximum_entries)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped_entry_count = skipped_entry_count.saturating_add(1);
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                skipped_entry_count = skipped_entry_count.saturating_add(1);
                continue;
            }
        };
        let relative = PathBuf::from(entry.file_name());
        if file_type.is_symlink() {
            skipped_entry_count = skipped_entry_count.saturating_add(1);
            continue;
        }
        if file_type.is_file() {
            collect_jsonl_file(
                relative,
                &mut files,
                request.maximum_files,
                &mut skipped_entry_count,
            )?;
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }
        directory_count = directory_count.saturating_add(1);
        if directory_count > request.maximum_directories {
            return Err(project_path_error(
                "session_directory_limit_exceeded",
                "会话根目录中的项目目录数量超过扫描上限。",
                "缩小授权范围或提高受控限制后重试。",
                false,
                "stage=session_listing; directories=too_many",
            ));
        }
        let child = match open_directory_at(root.as_raw_fd(), relative.as_os_str()) {
            Ok(child) => child,
            Err(_) => {
                skipped_entry_count = skipped_entry_count.saturating_add(1);
                continue;
            }
        };
        let child_entries = match fs::read_dir(fd_directory_path(child.as_raw_fd())) {
            Ok(entries) => entries,
            Err(_) => {
                skipped_entry_count = skipped_entry_count.saturating_add(1);
                continue;
            }
        };
        for child_entry in child_entries {
            entry_count = entry_count.saturating_add(1);
            enforce_session_entry_limit(entry_count, request.maximum_entries)?;
            let child_entry = match child_entry {
                Ok(entry) => entry,
                Err(_) => {
                    skipped_entry_count = skipped_entry_count.saturating_add(1);
                    continue;
                }
            };
            let file_type = match child_entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    skipped_entry_count = skipped_entry_count.saturating_add(1);
                    continue;
                }
            };
            if file_type.is_symlink() {
                skipped_entry_count = skipped_entry_count.saturating_add(1);
                continue;
            }
            if file_type.is_file() {
                collect_jsonl_file(
                    relative.join(child_entry.file_name()),
                    &mut files,
                    request.maximum_files,
                    &mut skipped_entry_count,
                )?;
            }
        }
    }
    files.sort();
    Ok(AllowedJsonlListing {
        files,
        skipped_entry_count,
    })
}

#[cfg(target_os = "linux")]
fn read_allowed_local_file_anchored(
    request: AllowedReadRequest,
) -> Result<AllowedFileRead, DomainError> {
    use std::os::fd::AsRawFd;

    if request.maximum_bytes == 0 {
        return Err(project_path_error(
            "allowed_file_request_invalid",
            "受控文件读取请求缺少有效上限。",
            "恢复默认扫描限制后重试。",
            false,
            "stage=allowed_file_read; request=invalid",
        ));
    }
    let root = open_verified_session_root(
        &request.authorized_root,
        &request.expected_root_identity_json,
    )?;
    let components = safe_relative_components(&request.relative_path)?;
    if request
        .relative_path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        != Some("jsonl")
    {
        return Err(project_path_error(
            "allowed_file_invalid",
            "受控会话文件不是 JSONL 文件。",
            "重新扫描会话目录。",
            false,
            "stage=allowed_file_read; extension=invalid",
        ));
    }
    let (directory, file_name) = match components.as_slice() {
        [file_name] => (None, file_name),
        [directory_name, file_name] => (
            Some(open_directory_at(root.as_raw_fd(), directory_name)?),
            file_name,
        ),
        _ => {
            return Err(project_path_error(
                "allowed_file_outside_root",
                "会话文件路径超出允许的扫描深度。",
                "重新扫描 OMP sessions 目录。",
                false,
                "stage=allowed_file_read; depth=invalid",
            ));
        }
    };
    let directory_fd = directory
        .as_ref()
        .map_or(root.as_raw_fd(), AsRawFd::as_raw_fd);
    let file = open_file_at(directory_fd, file_name)?;
    let opened = file.metadata().map_err(|error| {
        project_path_io_error(
            "allowed_file_unavailable",
            "无法读取会话文件身份。",
            "重新扫描会话目录。",
            true,
            "inspect_opened_file",
            &error,
        )
    })?;
    if !opened.is_file() {
        return Err(project_path_error(
            "allowed_file_invalid",
            "打开的会话对象不是普通文件。",
            "重新扫描会话目录。",
            false,
            "stage=allowed_file_read; opened_type=invalid",
        ));
    }
    let maximum_with_probe = request.maximum_bytes.checked_add(1).ok_or_else(|| {
        project_path_error(
            "allowed_file_request_invalid",
            "会话文件读取上限超出支持范围。",
            "恢复默认扫描限制后重试。",
            false,
            "stage=allowed_file_read; maximum=overflow",
        )
    })?;
    let mut bytes = Vec::with_capacity(request.maximum_bytes.min(64 * 1024));
    (&file)
        .take(maximum_with_probe as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            project_path_io_error(
                "allowed_file_read_failed",
                "读取会话文件时失败。",
                "重新扫描会话目录。",
                true,
                "read_allowed_file",
                &error,
            )
        })?;
    let truncated_by_limit = bytes.len() > request.maximum_bytes;
    bytes.truncate(request.maximum_bytes);
    let opened_after = file.metadata().map_err(|error| {
        project_path_io_error(
            "allowed_file_changed",
            "无法在读取后复核会话文件身份。",
            "稍后重新扫描。",
            true,
            "reinspect_opened_file",
            &error,
        )
    })?;
    let current_path_file = open_file_at(directory_fd, file_name).map_err(|error| {
        project_path_error(
            "allowed_file_changed",
            "会话文件名在读取期间被移动或替换。",
            "稍后重新扫描。",
            true,
            &format!("stage=reopen_allowed_file; cause={}", redact(&error.code)),
        )
    })?;
    let current_path_metadata = current_path_file.metadata().map_err(|error| {
        project_path_io_error(
            "allowed_file_changed",
            "无法在读取后复核会话文件名。",
            "稍后重新扫描。",
            true,
            "inspect_reopened_file",
            &error,
        )
    })?;
    use std::os::unix::fs::MetadataExt;
    if opened.dev() != opened_after.dev()
        || opened.ino() != opened_after.ino()
        || !current_path_metadata.is_file()
        || opened_after.dev() != current_path_metadata.dev()
        || opened_after.ino() != current_path_metadata.ino()
    {
        return Err(project_path_error(
            "allowed_file_changed",
            "会话文件在读取期间被替换。",
            "稍后重新扫描。",
            true,
            "stage=allowed_file_read; file_identity=changed",
        ));
    }
    let source_changed_during_read = opened.len() != opened_after.len()
        || opened.modified().ok() != opened_after.modified().ok();
    let source_identity_json = local_file_identity_json(&opened_after)?;
    let modified_at_epoch_ms = opened_after
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .unwrap_or_default();
    Ok(AllowedFileRead {
        source_truncated: truncated_by_limit
            || source_changed_during_read
            || opened_after.len() > bytes.len() as u64,
        source_size: opened_after.len(),
        modified_at_epoch_ms,
        source_identity_json,
        bytes,
    })
}

#[cfg(target_os = "linux")]
fn open_verified_session_root(
    path: &Path,
    expected_identity_json: &str,
) -> Result<File, DomainError> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    if !path.is_absolute() || expected_identity_json.len() > 65_536 {
        return Err(project_path_error(
            "session_root_invalid",
            "会话根授权数据无效。",
            "重新授权 OMP sessions 目录。",
            false,
            "stage=session_root_handle; input=invalid",
        ));
    }
    let identity: serde_json::Value =
        serde_json::from_str(expected_identity_json).map_err(|_| {
            project_path_error(
                "session_root_identity_invalid",
                "会话根身份记录无法验证。",
                "重新授权 OMP sessions 目录。",
                false,
                "stage=session_root_handle; identity=invalid_json",
            )
        })?;
    if identity.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_dev_ino_v1") {
        return Err(project_path_error(
            "session_root_identity_invalid",
            "会话根身份方案未经当前平台验证。",
            "重新授权 OMP sessions 目录。",
            false,
            "stage=session_root_handle; identity=unsupported_scheme",
        ));
    }
    let expected_device = identity
        .get("device")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            project_path_error(
                "session_root_identity_invalid",
                "会话根身份缺少设备标识。",
                "重新授权 OMP sessions 目录。",
                false,
                "stage=session_root_handle; device=missing",
            )
        })?;
    let expected_inode = identity
        .get("inode")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            project_path_error(
                "session_root_identity_invalid",
                "会话根身份缺少文件标识。",
                "重新授权 OMP sessions 目录。",
                false,
                "stage=session_root_handle; inode=missing",
            )
        })?;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        project_path_error(
            "session_root_invalid",
            "会话根路径包含无效字符。",
            "重新授权 OMP sessions 目录。",
            false,
            "stage=session_root_handle; path=nul",
        )
    })?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(project_path_io_error(
            "session_root_unavailable",
            "无法以安全句柄打开会话根目录。",
            "重新授权 OMP sessions 目录。",
            true,
            "open_session_root_handle",
            &io::Error::last_os_error(),
        ));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata().map_err(|error| {
        project_path_io_error(
            "session_root_unavailable",
            "无法复核会话根目录句柄。",
            "重新授权 OMP sessions 目录。",
            true,
            "inspect_session_root_handle",
            &error,
        )
    })?;
    if !metadata.is_dir() || metadata.dev() != expected_device || metadata.ino() != expected_inode {
        return Err(project_path_error(
            "session_root_replaced",
            "会话根目录在授权后发生变化。",
            "重新授权预期的 OMP sessions 目录。",
            false,
            "stage=session_root_handle; identity=changed",
        ));
    }
    Ok(file)
}

#[cfg(target_os = "linux")]
fn open_directory_at(parent: std::os::fd::RawFd, name: &std::ffi::OsStr) -> io::Result<File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul in directory name"))?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(target_os = "linux")]
fn open_file_at(parent: std::os::fd::RawFd, name: &std::ffi::OsStr) -> Result<File, DomainError> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| {
        project_path_error(
            "allowed_file_invalid",
            "会话文件名包含无效字符。",
            "重新扫描会话目录。",
            false,
            "stage=allowed_file_openat; name=nul",
        )
    })?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ELOOP) {
            Err(project_path_error(
                "allowed_file_invalid",
                "会话文件是符号链接，已拒绝读取。",
                "移除符号链接后重新扫描。",
                false,
                "stage=allowed_file_openat; type=symlink",
            ))
        } else {
            Err(project_path_io_error(
                "allowed_file_unavailable",
                "无法以安全句柄打开会话文件。",
                "重新扫描会话目录。",
                true,
                "openat_allowed_file",
                &error,
            ))
        }
    } else {
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(target_os = "linux")]
fn safe_relative_components(path: &Path) -> Result<Vec<&std::ffi::OsStr>, DomainError> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => components.push(value),
            _ => {
                return Err(project_path_error(
                    "allowed_file_outside_root",
                    "会话文件包含不允许的路径分量。",
                    "重新扫描 OMP sessions 目录。",
                    false,
                    "stage=allowed_file_read; component=invalid",
                ));
            }
        }
    }
    if components.is_empty() || components.len() > 2 {
        return Err(project_path_error(
            "allowed_file_outside_root",
            "会话文件路径超出允许的扫描深度。",
            "重新扫描 OMP sessions 目录。",
            false,
            "stage=allowed_file_read; depth=invalid",
        ));
    }
    Ok(components)
}

#[cfg(target_os = "linux")]
fn fd_directory_path(descriptor: std::os::fd::RawFd) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{descriptor}"))
}

fn enforce_session_entry_limit(
    entry_count: usize,
    maximum_entries: usize,
) -> Result<(), DomainError> {
    if entry_count <= maximum_entries {
        return Ok(());
    }
    Err(project_path_error(
        "session_entry_limit_exceeded",
        "会话根目录中的条目数量超过扫描上限。",
        "缩小授权范围或提高受控限制后重试。",
        false,
        "stage=session_listing; entries=too_many",
    ))
}

fn collect_jsonl_file(
    path: PathBuf,
    files: &mut Vec<PathBuf>,
    maximum_files: usize,
    skipped_entry_count: &mut u64,
) -> Result<(), DomainError> {
    if path.extension().and_then(std::ffi::OsStr::to_str) != Some("jsonl") {
        return Ok(());
    }
    if files.len() >= maximum_files {
        return Err(project_path_error(
            "session_file_limit_exceeded",
            "会话文件数量超过扫描上限。",
            "缩小授权范围或提高受控限制后重试。",
            false,
            "stage=session_listing; files=too_many",
        ));
    }
    if path.file_name().is_none() {
        *skipped_entry_count = skipped_entry_count.saturating_add(1);
    } else {
        files.push(path);
    }
    Ok(())
}

#[cfg(any())]
fn canonical_directory_root(path: &Path) -> Result<PathBuf, DomainError> {
    if !path.is_absolute() {
        return Err(project_path_error(
            "session_root_not_absolute",
            "会话根目录不是绝对路径。",
            "重新授权会话目录。",
            false,
            "stage=session_root; path=relative",
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        project_path_io_error(
            "session_root_unavailable",
            "无法访问已授权的会话根目录。",
            "确认目录仍然存在且当前用户有权访问。",
            true,
            "canonicalize_session_root",
            &error,
        )
    })?;
    let metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        project_path_io_error(
            "session_root_unavailable",
            "无法复核已授权的会话根目录。",
            "重新授权会话目录。",
            true,
            "inspect_session_root",
            &error,
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(project_path_error(
            "session_root_invalid",
            "已授权的会话根路径不是普通目录。",
            "重新选择 OMP sessions 目录。",
            false,
            "stage=session_root; type=invalid",
        ));
    }
    Ok(canonical)
}

#[cfg(target_os = "linux")]
fn read_allowed_local_file(request: AllowedReadRequest) -> Result<AllowedFileRead, DomainError> {
    read_allowed_local_file_anchored(request)
}

#[cfg(not(target_os = "linux"))]
fn read_allowed_local_file(request: AllowedReadRequest) -> Result<AllowedFileRead, DomainError> {
    let _ = request;
    Err(project_path_error(
        "session_file_identity_unverified",
        "当前平台尚未实现基于目录句柄的会话读取。",
        "等待平台文件身份验证完成后重试。",
        false,
        "stage=allowed_file_read; platform=unverified",
    ))
}

#[cfg(any())]
fn read_allowed_local_file_legacy_uncompiled(
    request: AllowedReadRequest,
) -> Result<AllowedFileRead, DomainError> {
    #[cfg(target_os = "linux")]
    {
        return read_allowed_local_file_anchored(request);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = request;
        return Err(project_path_error(
            "session_file_identity_unverified",
            "当前平台尚未实现基于目录句柄的会话读取。",
            "等待平台文件身份验证完成后重试。",
            false,
            "stage=allowed_file_read; platform=unverified",
        ));
    }
    #[cfg(any())]
    {
        if request.maximum_bytes == 0 || request.authorized_roots.is_empty() {
            return Err(project_path_error(
                "allowed_file_request_invalid",
                "受控文件读取请求缺少授权或有效上限。",
                "重新授权 Profile 会话目录后重试。",
                false,
                "stage=allowed_file_read; request=invalid",
            ));
        }
        let before = fs::symlink_metadata(&request.path).map_err(|error| {
            project_path_io_error(
                "allowed_file_unavailable",
                "会话文件当前不可访问。",
                "重新扫描会话目录。",
                true,
                "inspect_allowed_file",
                &error,
            )
        })?;
        if before.file_type().is_symlink() || !before.is_file() {
            return Err(project_path_error(
                "allowed_file_invalid",
                "会话文件不是可读取的普通文件。",
                "移除符号链接或特殊文件后重新扫描。",
                false,
                "stage=allowed_file_read; type=invalid",
            ));
        }
        let canonical_path = fs::canonicalize(&request.path).map_err(|error| {
            project_path_io_error(
                "allowed_file_unavailable",
                "无法解析会话文件路径。",
                "重新扫描会话目录。",
                true,
                "canonicalize_allowed_file",
                &error,
            )
        })?;
        let mut authorized = false;
        for root in &request.authorized_roots {
            let canonical_root = canonical_directory_root(root)?;
            if canonical_path.starts_with(&canonical_root) {
                authorized = true;
                break;
            }
        }
        if !authorized {
            return Err(project_path_error(
                "allowed_file_outside_root",
                "会话文件不属于已授权目录。",
                "重新选择正确的 Profile 会话根目录。",
                false,
                "stage=allowed_file_read; authorization=denied",
            ));
        }

        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&canonical_path).map_err(|error| {
            project_path_io_error(
                "allowed_file_unavailable",
                "无法以安全只读方式打开会话文件。",
                "重新扫描会话目录。",
                true,
                "open_allowed_file",
                &error,
            )
        })?;
        let opened = file.metadata().map_err(|error| {
            project_path_io_error(
                "allowed_file_unavailable",
                "无法读取会话文件身份。",
                "重新扫描会话目录。",
                true,
                "inspect_opened_file",
                &error,
            )
        })?;
        if !opened.is_file() {
            return Err(project_path_error(
                "allowed_file_invalid",
                "打开的会话对象不是普通文件。",
                "重新扫描会话目录。",
                false,
                "stage=allowed_file_read; opened_type=invalid",
            ));
        }
        let maximum_with_probe = request.maximum_bytes.checked_add(1).ok_or_else(|| {
            project_path_error(
                "allowed_file_request_invalid",
                "会话文件读取上限超出支持范围。",
                "恢复默认扫描限制后重试。",
                false,
                "stage=allowed_file_read; maximum=overflow",
            )
        })?;
        let mut bytes = Vec::with_capacity(request.maximum_bytes.min(64 * 1024));
        (&file)
            .take(maximum_with_probe as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                project_path_io_error(
                    "allowed_file_read_failed",
                    "读取会话文件时失败。",
                    "重新扫描会话目录。",
                    true,
                    "read_allowed_file",
                    &error,
                )
            })?;
        let truncated_by_limit = bytes.len() > request.maximum_bytes;
        bytes.truncate(request.maximum_bytes);
        let opened_after = file.metadata().map_err(|error| {
            project_path_io_error(
                "allowed_file_changed",
                "无法在读取后复核会话文件身份。",
                "稍后重新扫描。",
                true,
                "reinspect_opened_file",
                &error,
            )
        })?;
        let after = fs::symlink_metadata(&canonical_path).map_err(|error| {
            project_path_io_error(
                "allowed_file_changed",
                "会话文件在读取期间被移动或替换。",
                "稍后重新扫描。",
                true,
                "reinspect_allowed_file",
                &error,
            )
        })?;
        if after.file_type().is_symlink() || !after.is_file() {
            return Err(project_path_error(
                "allowed_file_changed",
                "会话文件在读取期间被替换。",
                "稍后重新扫描。",
                true,
                "stage=allowed_file_read; path_identity=changed",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            if opened.dev() != opened_after.dev()
                || opened.ino() != opened_after.ino()
                || opened_after.dev() != after.dev()
                || opened_after.ino() != after.ino()
            {
                return Err(project_path_error(
                    "allowed_file_changed",
                    "会话文件在读取期间被替换。",
                    "稍后重新扫描。",
                    true,
                    "stage=allowed_file_read; file_identity=changed",
                ));
            }
        }
        let source_changed_during_read = opened.len() != opened_after.len()
            || opened.modified().ok() != opened_after.modified().ok();
        let source_identity_json = local_file_identity_json(&opened_after)?;
        let modified_at_epoch_ms = opened_after
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|value| u64::try_from(value.as_millis()).ok())
            .unwrap_or_default();
        Ok(AllowedFileRead {
            source_truncated: truncated_by_limit
                || source_changed_during_read
                || opened_after.len() > bytes.len() as u64,
            source_size: opened_after.len(),
            modified_at_epoch_ms,
            source_identity_json,
            bytes,
        })
    }
}

fn local_file_identity_json(metadata: &fs::Metadata) -> Result<String, DomainError> {
    #[cfg(unix)]
    let value = {
        use std::os::unix::fs::MetadataExt;

        json!({
            "scheme": "unix_file_v1",
            "device": metadata.dev(),
            "inode": metadata.ino(),
            "size": metadata.len(),
            "modified_epoch_nanos": metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_nanos().to_string()),
        })
    };
    #[cfg(not(unix))]
    let value = json!({
        "scheme": "portable_file_v1",
        "size": metadata.len(),
        "modified_epoch_nanos": metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().to_string()),
    });
    serde_json::to_string(&value).map_err(|_| {
        project_path_error(
            "allowed_file_identity_failed",
            "无法编码会话文件身份。",
            "重新扫描会话目录。",
            true,
            "stage=allowed_file_read; identity=encode_failed",
        )
    })
}

const MAXIMUM_GIT_POINTER_BYTES: u64 = 4_096;

#[cfg(target_os = "linux")]
fn inspect_authorized_session_directory(path: &Path) -> Result<CanonicalDirectory, DomainError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    if !path.is_absolute() {
        return Err(project_path_error(
            "session_root_not_absolute",
            "所选会话根不是绝对路径。",
            "请使用系统目录选择器重新选择 OMP sessions 目录。",
            false,
            "stage=authorize_session_directory; path=relative",
        ));
    }
    let encoded = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        project_path_error(
            "session_root_invalid",
            "所选会话根路径包含无效字符。",
            "重新选择 OMP sessions 目录。",
            false,
            "stage=authorize_session_directory; path=nul",
        )
    })?;
    let descriptor = unsafe {
        libc::open(
            encoded.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Err(project_path_error(
                "session_root_symlink_rejected",
                "所选会话根是符号链接。",
                "请选择真实的 OMP sessions 目录。",
                false,
                "stage=authorize_session_directory; type=symlink",
            ));
        }
        if error.raw_os_error() == Some(libc::ENOTDIR) {
            return Err(project_path_error(
                "session_root_not_directory",
                "所选会话根路径不再是目录。",
                "重新选择真实的 OMP sessions 目录。",
                false,
                "stage=authorize_session_directory; type=not_directory",
            ));
        }
        return Err(project_path_io_error(
            "session_root_unavailable",
            "无法以安全句柄打开所选会话根。",
            "确认目录和权限后重新选择。",
            true,
            "open_authorized_session_root",
            &error,
        ));
    }
    let directory = unsafe { File::from_raw_fd(descriptor) };
    let opened = directory.metadata().map_err(|error| {
        project_path_io_error(
            "session_root_unavailable",
            "无法读取所选会话根身份。",
            "重新选择 OMP sessions 目录。",
            true,
            "inspect_authorized_session_handle",
            &error,
        )
    })?;
    if !opened.is_dir() {
        return Err(project_path_error(
            "session_root_invalid",
            "所选会话根不是普通目录。",
            "重新选择 OMP sessions 目录。",
            false,
            "stage=authorize_session_directory; type=not_directory",
        ));
    }
    let canonical_path =
        fs::read_link(fd_directory_path(directory.as_raw_fd())).map_err(|error| {
            project_path_io_error(
                "session_root_unavailable",
                "无法从已打开句柄解析会话根路径。",
                "重新选择 OMP sessions 目录。",
                true,
                "resolve_authorized_session_handle",
                &error,
            )
        })?;
    if !canonical_path.is_absolute() {
        return Err(project_path_error(
            "session_root_invalid",
            "无法确认会话根的绝对路径。",
            "重新选择 OMP sessions 目录。",
            false,
            "stage=authorize_session_directory; canonical=relative",
        ));
    }
    let path_metadata = fs::symlink_metadata(&canonical_path).map_err(|error| {
        project_path_io_error(
            "session_root_changed",
            "会话根在授权期间被移动或删除。",
            "重新选择 OMP sessions 目录。",
            true,
            "reinspect_authorized_session_path",
            &error,
        )
    })?;
    let opened_after = directory.metadata().map_err(|error| {
        project_path_io_error(
            "session_root_changed",
            "无法在授权后复核会话根身份。",
            "重新选择 OMP sessions 目录。",
            true,
            "reinspect_authorized_session_handle",
            &error,
        )
    })?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_dir()
        || opened.dev() != opened_after.dev()
        || opened.ino() != opened_after.ino()
        || opened_after.dev() != path_metadata.dev()
        || opened_after.ino() != path_metadata.ino()
    {
        return Err(project_path_error(
            "session_root_changed",
            "会话根在授权期间发生变化。",
            "重新选择 OMP sessions 目录。",
            true,
            "stage=authorize_session_directory; identity=changed",
        ));
    }
    let stable_identity_json = serde_json::to_string(&json!({
        "scheme": "unix_dev_ino_v1",
        "device": opened_after.dev(),
        "inode": opened_after.ino(),
    }))
    .map_err(|_| {
        project_path_error(
            "session_root_identity_failed",
            "无法记录会话根身份。",
            "重新选择 OMP sessions 目录。",
            false,
            "stage=authorize_session_directory; identity=encode_failed",
        )
    })?;
    Ok(CanonicalDirectory {
        canonical_path,
        stable_identity_json,
    })
}

#[cfg(not(target_os = "linux"))]
fn inspect_authorized_session_directory(_path: &Path) -> Result<CanonicalDirectory, DomainError> {
    Err(project_path_error(
        "session_file_identity_unverified",
        "当前平台尚未实现会话根句柄授权。",
        "等待平台文件身份验证完成后重试。",
        false,
        "stage=authorize_session_directory; platform=unverified",
    ))
}

fn inspect_authorized_directory(path: &Path) -> Result<CanonicalDirectory, DomainError> {
    if !path.is_absolute() {
        return Err(project_path_error(
            "project_path_not_absolute",
            "所选项目路径不是绝对路径。",
            "请使用系统目录选择器重新选择项目目录。",
            false,
            "stage=authorize_directory; path=relative",
        ));
    }

    let canonical_path = fs::canonicalize(path).map_err(|error| {
        project_path_io_error(
            "project_path_unavailable",
            "无法访问所选项目目录。",
            "确认目录仍然存在且当前用户有权访问后重试。",
            true,
            "canonicalize",
            &error,
        )
    })?;
    let canonical_text = canonical_path.to_str().ok_or_else(|| {
        project_path_error(
            "project_path_not_utf8",
            "所选项目路径无法安全表示。",
            "当前版本仅支持可表示为 Unicode 的项目路径。",
            false,
            "stage=authorize_directory; encoding=non_utf8",
        )
    })?;
    let metadata = fs::symlink_metadata(&canonical_path).map_err(|error| {
        project_path_io_error(
            "project_path_unavailable",
            "无法复核所选项目目录。",
            "确认目录没有在选择后被移动或替换。",
            true,
            "inspect",
            &error,
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(project_path_error(
            "project_path_not_directory",
            "所选项目路径不是可授权的目录。",
            "请重新选择一个现存的本地目录。",
            false,
            "stage=authorize_directory; type=not_directory",
        ));
    }

    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        json!({
            "scheme": "unix_dev_ino_v1",
            "device": metadata.dev(),
            "inode": metadata.ino(),
        })
    };
    #[cfg(not(unix))]
    let identity = json!({
        "scheme": "canonical_directory_v1",
        "canonical_path": canonical_text,
        "created_epoch_nanos": metadata
            .created()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().to_string()),
    });

    let stable_identity_json = serde_json::to_string(&identity).map_err(|error| {
        project_path_error(
            "project_identity_encode_failed",
            "无法记录所选项目目录的稳定身份。",
            "重新选择目录后重试。",
            false,
            &format!(
                "stage=authorize_directory; error={}",
                redact(&error.to_string())
            ),
        )
    })?;
    let _ = canonical_text;
    Ok(CanonicalDirectory {
        canonical_path,
        stable_identity_json,
    })
}

fn resolve_local_git_identity(path: &Path) -> Result<Option<GitIdentity>, DomainError> {
    for repository_root in path.ancestors() {
        let marker = repository_root.join(".git");
        let metadata = match fs::symlink_metadata(&marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(project_path_io_error(
                    "git_identity_unavailable",
                    "无法检查项目的 Git 标识。",
                    "项目仍可使用；请检查仓库目录权限后重新添加以刷新标识。",
                    true,
                    "inspect_marker",
                    &error,
                ));
            }
        };

        let git_directory = if metadata.is_dir() {
            fs::canonicalize(&marker).map_err(|error| {
                project_path_io_error(
                    "git_identity_unavailable",
                    "无法解析项目的 Git 元数据目录。",
                    "项目仍可使用；请检查仓库目录权限。",
                    true,
                    "canonicalize_git_directory",
                    &error,
                )
            })?
        } else if metadata.is_file() && !metadata.file_type().is_symlink() {
            let pointer = read_bounded_git_text(&marker, metadata.len(), "git_pointer")?;
            let value = pointer
                .trim()
                .strip_prefix("gitdir:")
                .map(str::trim)
                .filter(|value| !value.is_empty() && !value.contains('\0'))
                .ok_or_else(|| malformed_git_identity("pointer_format"))?;
            let value = PathBuf::from(value);
            let target = if value.is_absolute() {
                value
            } else {
                repository_root.join(value)
            };
            fs::canonicalize(target).map_err(|error| {
                project_path_io_error(
                    "git_identity_unavailable",
                    "无法解析项目的 Git worktree 标识。",
                    "项目仍可使用；请检查 .git 指针后重新添加。",
                    true,
                    "canonicalize_git_pointer",
                    &error,
                )
            })?
        } else {
            return Err(malformed_git_identity("marker_type"));
        };

        if !git_directory.is_dir() {
            return Err(malformed_git_identity("git_directory_type"));
        }
        let common_directory = resolve_common_git_directory(&git_directory)?;
        let relative = path
            .strip_prefix(repository_root)
            .map_err(|_| malformed_git_identity("repository_relative_path"))?;
        return Ok(Some(GitIdentity {
            common_directory,
            repository_relative_path: if relative.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                relative.to_owned()
            },
        }));
    }

    Ok(None)
}

fn resolve_common_git_directory(git_directory: &Path) -> Result<PathBuf, DomainError> {
    let pointer_path = git_directory.join("commondir");
    let metadata = match fs::symlink_metadata(&pointer_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(git_directory.to_owned());
        }
        Err(error) => {
            return Err(project_path_io_error(
                "git_identity_unavailable",
                "无法检查 Git common directory。",
                "项目仍可使用；请检查 Git 元数据目录权限。",
                true,
                "inspect_common_directory",
                &error,
            ));
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(malformed_git_identity("common_directory_pointer_type"));
    }
    let pointer = read_bounded_git_text(&pointer_path, metadata.len(), "common_directory")?;
    let value = pointer.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(malformed_git_identity("common_directory_pointer_format"));
    }
    let value = PathBuf::from(value);
    let target = if value.is_absolute() {
        value
    } else {
        git_directory.join(value)
    };
    let common_directory = fs::canonicalize(target).map_err(|error| {
        project_path_io_error(
            "git_identity_unavailable",
            "无法解析 Git common directory。",
            "项目仍可使用；请检查 Git 元数据目录。",
            true,
            "canonicalize_common_directory",
            &error,
        )
    })?;
    if !common_directory.is_dir() {
        return Err(malformed_git_identity("common_directory_type"));
    }
    Ok(common_directory)
}

fn read_bounded_git_text(path: &Path, length: u64, stage: &str) -> Result<String, DomainError> {
    if length > MAXIMUM_GIT_POINTER_BYTES {
        return Err(malformed_git_identity("pointer_too_large"));
    }
    let file = fs::File::open(path).map_err(|error| {
        project_path_io_error(
            "git_identity_unavailable",
            "无法读取 Git 元数据指针。",
            "项目仍可使用；请检查 Git 元数据目录权限。",
            true,
            stage,
            &error,
        )
    })?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAXIMUM_GIT_POINTER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            project_path_io_error(
                "git_identity_unavailable",
                "无法读取 Git 元数据指针。",
                "项目仍可使用；请检查 Git 元数据目录权限。",
                true,
                stage,
                &error,
            )
        })?;
    if bytes.len() as u64 > MAXIMUM_GIT_POINTER_BYTES {
        return Err(malformed_git_identity("pointer_too_large"));
    }
    String::from_utf8(bytes).map_err(|_| malformed_git_identity("pointer_encoding"))
}

fn malformed_git_identity(reason: &str) -> DomainError {
    project_path_error(
        "git_identity_invalid",
        "项目包含无法识别的 Git 元数据标识。",
        "项目仍可使用；修复 Git 元数据后重新添加可刷新标识。",
        false,
        &format!("stage=resolve_git_identity; reason={reason}"),
    )
}

fn project_path_io_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    stage: &str,
    error: &io::Error,
) -> DomainError {
    project_path_error(
        code,
        message,
        suggestion,
        retryable,
        &format!("stage={stage}; io_kind={:?}", error.kind()),
    )
}

fn project_path_error(
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
    use super::*;
    use tempfile::tempdir;

    #[cfg(target_os = "linux")]
    #[test]
    fn external_terminal_protocols_keep_paths_and_arguments_as_distinct_argv() {
        let cwd = Path::new("/tmp/project ; $(touch should-not-run)");
        let command = Path::new("/proc/42/fd/7");
        let prefix = vec![PathBuf::from("/proc/42/fd/8")];
        let omp_arguments = vec![
            "--cwd".to_owned(),
            cwd.display().to_string(),
            "--model".to_owned(),
            "provider/model;echo nope".to_owned(),
        ];

        for protocol in [
            LinuxTerminalProtocol::Xfce,
            LinuxTerminalProtocol::Gnome,
            LinuxTerminalProtocol::Konsole,
            LinuxTerminalProtocol::Kitty,
            LinuxTerminalProtocol::Alacritty,
            LinuxTerminalProtocol::WezTerm,
            LinuxTerminalProtocol::Foot,
            LinuxTerminalProtocol::Xterm,
        ] {
            let arguments =
                linux_terminal_arguments(protocol, cwd, command, &prefix, &omp_arguments);
            let expected_tail = [
                command.as_os_str(),
                prefix[0].as_os_str(),
                std::ffi::OsStr::new("--cwd"),
                cwd.as_os_str(),
                std::ffi::OsStr::new("--model"),
                std::ffi::OsStr::new("provider/model;echo nope"),
            ];
            assert_eq!(
                arguments
                    .iter()
                    .rev()
                    .take(expected_tail.len())
                    .rev()
                    .map(OsString::as_os_str)
                    .collect::<Vec<_>>(),
                expected_tail
            );
            assert!(!arguments.iter().any(|argument| argument == "-c"));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lists_only_direct_and_one_level_regular_jsonl_files() {
        let root = tempdir().expect("root");
        let project = root.path().join("project");
        let nested = project.join("nested");
        fs::create_dir_all(&nested).expect("nested");
        let direct = root.path().join("direct.jsonl");
        let child = project.join("child.jsonl");
        fs::write(&direct, b"direct\n").expect("direct");
        fs::write(&child, b"child\n").expect("child");
        fs::write(project.join("ignored.txt"), b"ignored").expect("ignored");
        fs::write(nested.join("too-deep.jsonl"), b"deep").expect("deep");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            symlink(&direct, root.path().join("linked.jsonl")).expect("file symlink");
            symlink(&project, root.path().join("linked-directory")).expect("directory symlink");
        }

        let listing = list_allowed_jsonl_files(AllowedJsonlListingRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: inspect_authorized_directory(root.path())
                .expect("root identity")
                .stable_identity_json,
            maximum_entries: 64,
            maximum_directories: 8,
            maximum_files: 8,
        })
        .expect("listing");
        assert_eq!(
            listing.files,
            [
                PathBuf::from("direct.jsonl"),
                PathBuf::from("project").join("child.jsonl")
            ]
        );
        #[cfg(unix)]
        assert_eq!(listing.skipped_entry_count, 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_only_regular_files_beneath_an_authorized_root_with_a_hard_limit() {
        let root = tempdir().expect("root");
        let outside = tempdir().expect("outside");
        let session = root.path().join("session.jsonl");
        fs::write(&session, b"123456789").expect("session");

        let read = read_allowed_local_file(AllowedReadRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: inspect_authorized_directory(root.path())
                .expect("root identity")
                .stable_identity_json,
            relative_path: PathBuf::from("session.jsonl"),
            maximum_bytes: 5,
        })
        .expect("bounded read");
        assert_eq!(read.bytes, b"12345");
        assert_eq!(read.source_size, 9);
        assert!(read.source_truncated);
        assert!(
            read.source_identity_json
                .contains("\"scheme\":\"unix_file_v1\"")
                || read
                    .source_identity_json
                    .contains("\"scheme\":\"portable_file_v1\"")
        );

        let error = read_allowed_local_file(AllowedReadRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: inspect_authorized_directory(root.path())
                .expect("root identity")
                .stable_identity_json,
            relative_path: PathBuf::from("../outside.jsonl"),
            maximum_bytes: 16,
        })
        .expect_err("relative escape rejected");
        assert_eq!(error.code, "allowed_file_outside_root");

        fs::write(outside.path().join("outside.jsonl"), b"outside").expect("outside file");
        let error = read_allowed_local_file(AllowedReadRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: inspect_authorized_directory(root.path())
                .expect("root identity")
                .stable_identity_json,
            relative_path: PathBuf::from("../outside.jsonl"),
            maximum_bytes: 16,
        })
        .expect_err("existing outside file denied");
        assert_eq!(error.code, "allowed_file_outside_root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_symlink_files_and_enforces_listing_entry_limits() {
        use std::os::unix::fs::symlink;

        let root = tempdir().expect("root");
        let session = root.path().join("session.jsonl");
        let linked = root.path().join("linked.jsonl");
        fs::write(&session, b"session").expect("session");
        symlink(&session, &linked).expect("symlink");

        let error = read_allowed_local_file(AllowedReadRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: inspect_authorized_directory(root.path())
                .expect("root identity")
                .stable_identity_json,
            relative_path: PathBuf::from("linked.jsonl"),
            maximum_bytes: 16,
        })
        .expect_err("symlink rejected");
        assert_eq!(error.code, "allowed_file_invalid");

        fs::write(root.path().join("second.txt"), b"second").expect("second");
        let error = list_allowed_jsonl_files(AllowedJsonlListingRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: inspect_authorized_directory(root.path())
                .expect("root identity")
                .stable_identity_json,
            maximum_entries: 1,
            maximum_directories: 4,
            maximum_files: 4,
        })
        .expect_err("entry limit");
        assert_eq!(error.code, "session_entry_limit_exceeded");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn anchors_listing_to_the_authorized_root_identity() {
        let parent = tempdir().expect("parent");
        let root = parent.path().join("sessions");
        let original = parent.path().join("sessions-original");
        fs::create_dir(&root).expect("root");
        let identity = inspect_authorized_directory(&root)
            .expect("root identity")
            .stable_identity_json;
        fs::rename(&root, &original).expect("move original");
        fs::create_dir(&root).expect("replacement");

        let error = list_allowed_jsonl_files(AllowedJsonlListingRequest {
            authorized_root: root,
            expected_root_identity_json: identity,
            maximum_entries: 8,
            maximum_directories: 8,
            maximum_files: 8,
        })
        .expect_err("replacement rejected");
        assert_eq!(error.code, "session_root_replaced");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn refuses_a_fifo_without_blocking_the_reader() {
        use std::os::unix::ffi::OsStrExt;

        let root = tempdir().expect("root");
        let fifo = root.path().join("session.jsonl");
        let encoded = std::ffi::CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(encoded.as_ptr(), 0o600) }, 0);
        let identity = inspect_authorized_session_directory(root.path())
            .expect("root identity")
            .stable_identity_json;

        let error = read_allowed_local_file(AllowedReadRequest {
            authorized_root: root.path().to_owned(),
            expected_root_identity_json: identity,
            relative_path: PathBuf::from("session.jsonl"),
            maximum_bytes: 1_024,
        })
        .expect_err("fifo rejected");
        assert_eq!(error.code, "allowed_file_invalid");
    }
}
