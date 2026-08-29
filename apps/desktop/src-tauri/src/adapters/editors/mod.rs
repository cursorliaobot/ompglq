use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::domain::DomainError;
use crate::infrastructure::process::resolve_executable_on_path;

const MAXIMUM_CANDIDATES: usize = 8;

#[derive(Debug)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CursorLaunchProtocol {
    Classic,
    NewWindow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecutableIdentity {
    canonical_path: PathBuf,
    length: u64,
    modified_epoch_nanos: Option<u128>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Debug, Clone)]
pub struct VerifiedEditor {
    executable: ExecutableIdentity,
    protocol: CursorLaunchProtocol,
}

impl VerifiedEditor {
    #[cfg(test)]
    pub(crate) fn synthetic() -> Self {
        Self {
            executable: ExecutableIdentity {
                canonical_path: PathBuf::from("synthetic-cursor"),
                length: 0,
                modified_epoch_nanos: None,
                #[cfg(unix)]
                device: 0,
                #[cfg(unix)]
                inode: 0,
            },
            protocol: CursorLaunchProtocol::Classic,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditorLaunch {
    pub process_id: Option<u32>,
}

#[async_trait]
pub trait ExternalEditorAdapter: Send + Sync {
    fn editor_id(&self) -> &'static str;

    async fn probe(&self) -> Result<VerifiedEditor, DomainError>;

    async fn open_directory(
        &self,
        editor: &VerifiedEditor,
        directory: &Path,
        expected_directory_identity_json: &str,
    ) -> Result<EditorLaunch, DomainError>;
}

#[derive(Debug, Clone)]
pub struct CursorEditorAdapter {
    candidates: Option<Vec<PathBuf>>,
    help_timeout: Duration,
    maximum_output_bytes: usize,
}

impl Default for CursorEditorAdapter {
    fn default() -> Self {
        Self {
            candidates: None,
            help_timeout: Duration::from_secs(3),
            maximum_output_bytes: 32 * 1024,
        }
    }
}

impl CursorEditorAdapter {
    #[cfg(test)]
    fn with_candidates(candidates: Vec<PathBuf>) -> Self {
        Self {
            candidates: Some(candidates),
            help_timeout: Duration::from_secs(1),
            maximum_output_bytes: 16 * 1024,
        }
    }

    fn candidates(&self) -> Vec<PathBuf> {
        let candidates = self
            .candidates
            .clone()
            .unwrap_or_else(discover_cursor_candidates);
        let mut seen = HashSet::new();
        candidates
            .into_iter()
            .filter(|candidate| seen.insert(candidate.clone()))
            .take(MAXIMUM_CANDIDATES)
            .collect()
    }
}

#[async_trait]
impl ExternalEditorAdapter for CursorEditorAdapter {
    fn editor_id(&self) -> &'static str {
        "cursor"
    }

    async fn probe(&self) -> Result<VerifiedEditor, DomainError> {
        let candidates = self.candidates();
        if candidates.is_empty() {
            return Err(editor_error(
                "cursor_not_found",
                "未检测到 Cursor 桌面编辑器。",
                "安装 Cursor，或稍后在设置中登记其桌面程序。",
                true,
                "stage=cursor_probe; candidates=0",
            ));
        }

        let mut accessible_candidates = 0_usize;
        for candidate in &candidates {
            let Ok(identity) = executable_identity(candidate) else {
                continue;
            };
            accessible_candidates += 1;
            if !looks_like_cursor_program(&identity.canonical_path) {
                continue;
            }
            let Ok(help) = capture_help(
                &identity.canonical_path,
                self.help_timeout,
                self.maximum_output_bytes,
            )
            .await
            else {
                continue;
            };
            let Some(protocol) = parse_cursor_help(&help) else {
                continue;
            };
            let Ok(after_probe) = executable_identity(&identity.canonical_path) else {
                continue;
            };
            if after_probe == identity {
                return Ok(VerifiedEditor {
                    executable: identity,
                    protocol,
                });
            }
        }

        if accessible_candidates == 0 {
            Err(editor_error(
                "cursor_not_found",
                "未检测到 Cursor 桌面编辑器。",
                "安装 Cursor，或稍后在设置中登记其桌面程序。",
                true,
                &format!("stage=cursor_probe; candidates={}", candidates.len()),
            ))
        } else {
            Err(editor_error(
                "cursor_launcher_unverified",
                "检测到的程序无法验证为 Cursor 桌面启动器。",
                "确认 Cursor 安装完整；Cursor Agent CLI（agent）不能用于打开项目。",
                false,
                &format!("stage=cursor_probe; checked_candidates={accessible_candidates}"),
            ))
        }
    }

    async fn open_directory(
        &self,
        editor: &VerifiedEditor,
        directory: &Path,
        expected_directory_identity_json: &str,
    ) -> Result<EditorLaunch, DomainError> {
        let _directory_handle =
            open_verified_directory(directory, expected_directory_identity_json)?;
        let current_identity = executable_identity(&editor.executable.canonical_path)?;
        if current_identity != editor.executable {
            return Err(editor_error(
                "cursor_launcher_changed",
                "Cursor 桌面启动器在检测后发生变化。",
                "重新检测 Cursor 后再试。",
                true,
                "stage=cursor_open; executable_identity=changed",
            ));
        }
        let _executable_handle = open_verified_executable(&editor.executable)?;

        let mut command = Command::new(&editor.executable.canonical_path);
        command
            .arg(match editor.protocol {
                CursorLaunchProtocol::Classic => "--classic",
                CursorLaunchProtocol::NewWindow => "--new-window",
            })
            .arg(directory.as_os_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .env_clear();
        copy_editor_environment(&mut command);
        let child = command.spawn().map_err(|error| {
            editor_error(
                "cursor_launch_failed",
                "无法启动 Cursor 桌面编辑器。",
                "检查 Cursor 安装和当前用户的程序执行权限后重试。",
                true,
                &format!(
                    "stage=cursor_open; io_kind={:?}; raw_os_code={:?}",
                    error.kind(),
                    error.raw_os_error()
                ),
            )
        })?;

        Ok(EditorLaunch {
            process_id: child.id(),
        })
    }
}

fn discover_cursor_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(candidate) = resolve_executable_on_path("cursor") {
        candidates.push(candidate);
    }

    #[cfg(target_os = "linux")]
    {
        candidates.extend([
            PathBuf::from("/usr/bin/cursor"),
            PathBuf::from("/usr/local/bin/cursor"),
            PathBuf::from("/opt/Cursor/cursor"),
            PathBuf::from("/opt/cursor/cursor"),
        ]);
    }

    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("cursor")
                    .join("Cursor.exe"),
            );
        }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(program_files) = std::env::var_os(variable) {
                candidates.push(
                    PathBuf::from(program_files)
                        .join("Cursor")
                        .join("Cursor.exe"),
                );
            }
        }
    }

    candidates
}

fn executable_identity(path: &Path) -> Result<ExecutableIdentity, DomainError> {
    let canonical_path = std::fs::canonicalize(path).map_err(|error| {
        editor_error(
            "cursor_launcher_unavailable",
            "无法访问 Cursor 桌面启动器。",
            "重新安装或重新检测 Cursor。",
            true,
            &format!(
                "stage=cursor_identity; io_kind={:?}; raw_os_code={:?}",
                error.kind(),
                error.raw_os_error()
            ),
        )
    })?;
    let metadata = std::fs::symlink_metadata(&canonical_path).map_err(|error| {
        editor_error(
            "cursor_launcher_unavailable",
            "无法检查 Cursor 桌面启动器。",
            "重新安装或重新检测 Cursor。",
            true,
            &format!(
                "stage=cursor_identity; io_kind={:?}; raw_os_code={:?}",
                error.kind(),
                error.raw_os_error()
            ),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(editor_error(
            "cursor_launcher_invalid",
            "Cursor 启动器不是普通文件。",
            "重新安装 Cursor，不要选择目录或符号链接目标。",
            false,
            "stage=cursor_identity; type=not_regular_file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(editor_error(
                "cursor_launcher_not_executable",
                "Cursor 启动器不可执行。",
                "修复 Cursor 安装文件权限后重试。",
                true,
                "stage=cursor_identity; executable_bits=missing",
            ));
        }
        Ok(ExecutableIdentity {
            canonical_path,
            length: metadata.len(),
            modified_epoch_nanos: modified_epoch_nanos(&metadata),
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(ExecutableIdentity {
            canonical_path,
            length: metadata.len(),
            modified_epoch_nanos: modified_epoch_nanos(&metadata),
        })
    }
}

fn open_verified_executable(identity: &ExecutableIdentity) -> Result<File, DomainError> {
    let file = File::open(&identity.canonical_path).map_err(|error| {
        editor_error(
            "cursor_launcher_unavailable",
            "无法在启动边界打开 Cursor 启动器。",
            "重新检测 Cursor 后再试。",
            true,
            &format!(
                "stage=cursor_open_handle; io_kind={:?}; raw_os_code={:?}",
                error.kind(),
                error.raw_os_error()
            ),
        )
    })?;
    let metadata = file.metadata().map_err(|error| {
        editor_error(
            "cursor_launcher_unavailable",
            "无法在启动边界复核 Cursor 启动器。",
            "重新检测 Cursor 后再试。",
            true,
            &format!(
                "stage=cursor_open_handle; io_kind={:?}; raw_os_code={:?}",
                error.kind(),
                error.raw_os_error()
            ),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        if metadata.dev() != identity.device
            || metadata.ino() != identity.inode
            || metadata.len() != identity.length
            || modified_epoch_nanos(&metadata) != identity.modified_epoch_nanos
        {
            return Err(editor_error(
                "cursor_launcher_changed",
                "Cursor 启动器在检测后发生变化。",
                "重新检测 Cursor 后再试。",
                true,
                "stage=cursor_open_handle; executable_identity=changed",
            ));
        }
    }
    #[cfg(not(unix))]
    if metadata.len() != identity.length
        || modified_epoch_nanos(&metadata) != identity.modified_epoch_nanos
    {
        return Err(editor_error(
            "cursor_launcher_changed",
            "Cursor 启动器在检测后发生变化。",
            "重新检测 Cursor 后再试。",
            true,
            "stage=cursor_open_handle; executable_identity=changed",
        ));
    }
    if executable_identity(&identity.canonical_path)? != *identity {
        return Err(editor_error(
            "cursor_launcher_changed",
            "Cursor 启动器在启动边界发生变化。",
            "重新检测 Cursor 后再试。",
            true,
            "stage=cursor_open_handle; path_identity=changed",
        ));
    }
    Ok(file)
}

fn open_verified_directory(path: &Path, expected_identity_json: &str) -> Result<File, DomainError> {
    if !path.is_absolute() || expected_identity_json.len() > 65_536 {
        return Err(editor_error(
            "cursor_project_path_invalid",
            "项目目录在启动 Cursor 前已不可用。",
            "刷新项目状态并重新授权该目录。",
            false,
            "stage=cursor_directory_handle; input=invalid",
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let identity: serde_json::Value =
            serde_json::from_str(expected_identity_json).map_err(|_| {
                editor_error(
                    "cursor_project_identity_invalid",
                    "项目目录身份记录无法验证。",
                    "重新授权项目目录后重试。",
                    false,
                    "stage=cursor_directory_handle; identity=invalid_json",
                )
            })?;
        if identity.get("scheme").and_then(serde_json::Value::as_str) != Some("unix_dev_ino_v1") {
            return Err(editor_error(
                "cursor_project_identity_invalid",
                "项目目录身份方案未经当前平台验证。",
                "重新授权项目目录后重试。",
                false,
                "stage=cursor_directory_handle; identity=unsupported_scheme",
            ));
        }
        let expected_device = identity
            .get("device")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                editor_error(
                    "cursor_project_identity_invalid",
                    "项目目录身份记录缺少设备标识。",
                    "重新授权项目目录后重试。",
                    false,
                    "stage=cursor_directory_handle; device=missing",
                )
            })?;
        let expected_inode = identity
            .get("inode")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                editor_error(
                    "cursor_project_identity_invalid",
                    "项目目录身份记录缺少文件标识。",
                    "重新授权项目目录后重试。",
                    false,
                    "stage=cursor_directory_handle; inode=missing",
                )
            })?;
        let before = std::fs::symlink_metadata(path).map_err(|error| {
            editor_error(
                "cursor_project_path_invalid",
                "项目目录在启动 Cursor 前已不可用。",
                "刷新项目状态并重新授权该目录。",
                true,
                &format!(
                    "stage=cursor_directory_handle; io_kind={:?}; raw_os_code={:?}",
                    error.kind(),
                    error.raw_os_error()
                ),
            )
        })?;
        if before.file_type().is_symlink()
            || !before.is_dir()
            || before.dev() != expected_device
            || before.ino() != expected_inode
        {
            return Err(editor_error(
                "cursor_project_identity_changed",
                "项目目录在启动边界发生变化。",
                "重新授权预期目录；当前操作已安全停止。",
                false,
                "stage=cursor_directory_handle; path_identity=changed",
            ));
        }
        let file = File::open(path).map_err(|error| {
            editor_error(
                "cursor_project_path_invalid",
                "无法在启动边界打开项目目录。",
                "刷新项目状态并重新授权该目录。",
                true,
                &format!(
                    "stage=cursor_directory_handle; io_kind={:?}; raw_os_code={:?}",
                    error.kind(),
                    error.raw_os_error()
                ),
            )
        })?;
        let opened = file.metadata().map_err(|error| {
            editor_error(
                "cursor_project_path_invalid",
                "无法在启动边界复核项目目录。",
                "刷新项目状态并重新授权该目录。",
                true,
                &format!(
                    "stage=cursor_directory_handle; io_kind={:?}; raw_os_code={:?}",
                    error.kind(),
                    error.raw_os_error()
                ),
            )
        })?;
        let after = std::fs::symlink_metadata(path).map_err(|error| {
            editor_error(
                "cursor_project_path_invalid",
                "项目目录在启动边界已不可用。",
                "刷新项目状态并重新授权该目录。",
                true,
                &format!(
                    "stage=cursor_directory_handle; io_kind={:?}; raw_os_code={:?}",
                    error.kind(),
                    error.raw_os_error()
                ),
            )
        })?;
        if opened.dev() != expected_device
            || opened.ino() != expected_inode
            || after.file_type().is_symlink()
            || !after.is_dir()
            || after.dev() != expected_device
            || after.ino() != expected_inode
        {
            return Err(editor_error(
                "cursor_project_identity_changed",
                "项目目录在启动边界发生变化。",
                "重新授权预期目录；当前操作已安全停止。",
                false,
                "stage=cursor_directory_handle; opened_identity=changed",
            ));
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        let _ = expected_identity_json;
        Err(editor_error(
            "cursor_project_identity_unverified",
            "当前平台尚未实现可验证的项目目录句柄。",
            "等待平台文件身份验证完成后再试。",
            false,
            "stage=cursor_directory_handle; platform=unverified",
        ))
    }
}

fn modified_epoch_nanos(metadata: &std::fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

fn looks_like_cursor_program(path: &Path) -> bool {
    path.file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.to_ascii_lowercase().contains("cursor"))
}

fn parse_cursor_help(help: &str) -> Option<CursorLaunchProtocol> {
    let help = help.to_ascii_lowercase();
    let usage = help.lines().find_map(|line| {
        let value = line.trim().strip_prefix("usage:")?.trim();
        let command_end = value
            .find(|character: char| character.is_ascii_whitespace() || character == '[')
            .unwrap_or(value.len());
        (value[..command_end].trim_end_matches(".exe") == "cursor").then_some(value)
    })?;
    let desktop_usage =
        usage.contains("path") || usage.contains("file") || usage.contains("folder");
    let desktop_window_flags = help.contains("--new-window") && help.contains("--reuse-window");
    if !desktop_usage
        || !desktop_window_flags
        || help.contains("usage: agent")
        || help.contains("cursor agent cli")
    {
        return None;
    }

    if help.contains("--classic") {
        Some(CursorLaunchProtocol::Classic)
    } else {
        Some(CursorLaunchProtocol::NewWindow)
    }
}

async fn capture_help(
    executable: &Path,
    timeout: Duration,
    maximum_output_bytes: usize,
) -> Result<String, DomainError> {
    let deadline = Instant::now() + timeout;
    let mut command = Command::new(executable);
    command
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear();
    #[cfg(unix)]
    command.process_group(0);
    copy_editor_environment(&mut command);
    let mut child = command.spawn().map_err(|error| {
        editor_error(
            "cursor_probe_spawn_failed",
            "无法运行 Cursor 桌面启动器检测。",
            "检查 Cursor 安装权限后重试。",
            true,
            &format!(
                "stage=cursor_help; io_kind={:?}; raw_os_code={:?}",
                error.kind(),
                error.raw_os_error()
            ),
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        editor_error(
            "cursor_probe_output_unavailable",
            "无法读取 Cursor 启动器检测输出。",
            "重新检测 Cursor。",
            true,
            "stage=cursor_help; stdout=missing",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        editor_error(
            "cursor_probe_output_unavailable",
            "无法读取 Cursor 启动器检测错误输出。",
            "重新检测 Cursor。",
            true,
            "stage=cursor_help; stderr=missing",
        )
    })?;
    let mut stdout_task = tokio::spawn(read_bounded(stdout, maximum_output_bytes));
    let mut stderr_task = tokio::spawn(read_bounded(stderr, maximum_output_bytes));
    let child_process_id = child.id();

    #[cfg(target_os = "linux")]
    let (status, forced_descendant_cleanup) = match tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        wait_for_linux_child_exit(child_process_id),
    )
    .await
    {
        Ok(Ok(())) => {
            let descendants = linux_process_group_has_descendants(child_process_id);
            if descendants {
                kill_help_process_group(child_process_id);
            }
            let status = child.wait().await.map_err(|error| {
                editor_error(
                    "cursor_probe_wait_failed",
                    "等待 Cursor 启动器检测结束时失败。",
                    "重新检测 Cursor。",
                    true,
                    &format!("stage=cursor_help; io_kind={:?}", error.kind()),
                )
            })?;
            (status, descendants)
        }
        Ok(Err(error)) => {
            kill_help_process_group(child_process_id);
            terminate_help_process(&mut child, child_process_id).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
        Err(_) => {
            kill_help_process_group(child_process_id);
            terminate_help_process(&mut child, child_process_id).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(editor_error(
                "cursor_probe_timeout",
                "Cursor 启动器检测超时。",
                "确认 Cursor 安装可正常启动后重试。",
                true,
                &format!("stage=cursor_help; timeout_ms={}", timeout.as_millis()),
            ));
        }
    };
    #[cfg(not(target_os = "linux"))]
    let (status, forced_descendant_cleanup) = match tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        child.wait(),
    )
    .await
    {
        Ok(result) => (
            result.map_err(|error| {
                editor_error(
                    "cursor_probe_wait_failed",
                    "等待 Cursor 启动器检测结束时失败。",
                    "重新检测 Cursor。",
                    true,
                    &format!("stage=cursor_help; io_kind={:?}", error.kind()),
                )
            })?,
            false,
        ),
        Err(_) => {
            terminate_help_process(&mut child, child_process_id).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(editor_error(
                "cursor_probe_timeout",
                "Cursor 启动器检测超时。",
                "确认 Cursor 安装可正常启动后重试。",
                true,
                &format!("stage=cursor_help; timeout_ms={}", timeout.as_millis()),
            ));
        }
    };
    let outputs = tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), async {
        let stdout = collect_output(&mut stdout_task).await?;
        let stderr = collect_output(&mut stderr_task).await?;
        Ok::<_, DomainError>((stdout, stderr))
    })
    .await;
    let (stdout, stderr) = match outputs {
        Ok(result) => result?,
        Err(_) => {
            terminate_help_process(&mut child, child_process_id).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(editor_error(
                "cursor_probe_timeout",
                "Cursor 启动器检测输出未在总时间限制内结束。",
                "确认 Cursor 启动器及其子进程不会持续占用检测输出。",
                true,
                &format!(
                    "stage=cursor_help_output; timeout_ms={}",
                    timeout.as_millis()
                ),
            ));
        }
    };
    if !status.success() {
        return Err(editor_error(
            "cursor_probe_failed",
            "Cursor 启动器检测返回失败状态。",
            "确认 Cursor 安装完整后重试。",
            true,
            &format!("stage=cursor_help; exit_code={:?}", status.code()),
        ));
    }
    if stdout.truncated || stderr.truncated {
        return Err(editor_error(
            "cursor_probe_output_truncated",
            "Cursor 启动器检测输出超过安全上限。",
            "确认所选程序是标准 Cursor 桌面启动器。",
            false,
            "stage=cursor_help; output=truncated",
        ));
    }
    if forced_descendant_cleanup {
        return Err(editor_error(
            "cursor_probe_descendants_detected",
            "Cursor 启动器检测产生了未随主进程退出的子进程。",
            "确认所选程序是标准 Cursor 桌面启动器；本次不接受可能不完整的帮助证据。",
            false,
            "stage=cursor_help; descendants=terminated",
        ));
    }
    let mut output = String::from_utf8_lossy(&stdout.bytes).into_owned();
    if !stderr.bytes.is_empty() {
        output.push('\n');
        output.push_str(&String::from_utf8_lossy(&stderr.bytes));
    }
    Ok(output)
}

async fn terminate_help_process(child: &mut tokio::process::Child, _process_id: Option<u32>) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn kill_help_process_group(process_id: Option<u32>) {
    #[cfg(unix)]
    if let Some(process_id) = process_id.and_then(|value| i32::try_from(value).ok()) {
        // The help process starts in its own group; a negative PID targets that group only.
        unsafe {
            libc::kill(-process_id, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = process_id;
}

#[cfg(target_os = "linux")]
async fn wait_for_linux_child_exit(process_id: Option<u32>) -> Result<(), DomainError> {
    let process_id = process_id
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| {
            editor_error(
                "cursor_probe_wait_failed",
                "无法取得 Cursor 启动器检测进程标识。",
                "重新检测 Cursor。",
                true,
                "stage=cursor_help_wait; pid=missing",
            )
        })?;
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // WNOWAIT observes exit without reaping, preventing PID/PGID reuse before group inspection.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                process_id as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            return Err(editor_error(
                "cursor_probe_wait_failed",
                "等待 Cursor 启动器检测结束时失败。",
                "重新检测 Cursor。",
                true,
                &format!(
                    "stage=cursor_help_wait; io_kind={:?}; raw_os_code={:?}",
                    error.kind(),
                    error.raw_os_error()
                ),
            ));
        }
        // waitid initialized siginfo_t on success; si_pid=0 means WNOHANG observed no exit yet.
        let exited = unsafe { info.assume_init().si_pid() != 0 };
        if exited {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[cfg(target_os = "linux")]
fn linux_process_group_has_descendants(process_id: Option<u32>) -> bool {
    let Some(group_id) = process_id.and_then(|value| i32::try_from(value).ok()) else {
        return true;
    };
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return true;
    };
    for entry in entries.take(65_536).filter_map(Result::ok) {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        if pid == group_id {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(command_end) = stat.rfind(')') else {
            continue;
        };
        let mut fields = stat[command_end + 1..].split_whitespace();
        let _state = fields.next();
        let _parent = fields.next();
        let process_group = fields.next().and_then(|value| value.parse::<i32>().ok());
        if process_group == Some(group_id) {
            return true;
        }
    }
    false
}

async fn read_bounded<R>(mut reader: R, maximum: usize) -> std::io::Result<CapturedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(maximum.min(4 * 1024));
    let mut buffer = [0_u8; 4 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(CapturedOutput {
                bytes: retained,
                truncated,
            });
        }
        let keep = maximum.saturating_sub(retained.len()).min(count);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
}

async fn collect_output(
    task: &mut tokio::task::JoinHandle<std::io::Result<CapturedOutput>>,
) -> Result<CapturedOutput, DomainError> {
    task.await
        .map_err(|_| {
            editor_error(
                "cursor_probe_output_task_failed",
                "Cursor 启动器输出读取任务异常结束。",
                "重新检测 Cursor。",
                true,
                "stage=cursor_help; output_task=join_failed",
            )
        })?
        .map_err(|error| {
            editor_error(
                "cursor_probe_output_read_failed",
                "无法读取 Cursor 启动器检测输出。",
                "重新检测 Cursor。",
                true,
                &format!("stage=cursor_help; io_kind={:?}", error.kind()),
            )
        })
}

fn copy_editor_environment(command: &mut Command) {
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "DBUS_SESSION_BUS_ADDRESS",
        "SystemRoot",
        "WINDIR",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
    ];
    for name in ALLOWED {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn editor_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    detail: &str,
) -> DomainError {
    DomainError::new(code, message, suggestion, retryable, detail)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn accepts_only_desktop_cursor_help_and_selects_a_verified_protocol() {
        assert_eq!(
            parse_cursor_help(
                "Usage: cursor [options] [paths...]\n--new-window\n--reuse-window\n--classic"
            ),
            Some(CursorLaunchProtocol::Classic)
        );
        assert_eq!(
            parse_cursor_help("Usage: cursor [options] [paths...]\n--new-window\n--reuse-window"),
            Some(CursorLaunchProtocol::NewWindow)
        );
        assert_eq!(
            parse_cursor_help("Usage: agent [options]\nCursor Agent CLI\n--model"),
            None
        );
        assert_eq!(
            parse_cursor_help(
                "Usage: cursor-agent [folder]\n--new-window\n--reuse-window\n--classic"
            ),
            None
        );
        assert_eq!(parse_cursor_help("Usage: cursor <prompt>"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_a_dangerous_directory_as_one_argument_and_rechecks_identity() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("tempdir");
        let capture_path = directory.path().join("captured");
        let launcher_path = directory.path().join("cursor");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n\
             printf '%s\\n' 'Usage: cursor [options] [paths...]' \
             '--new-window' '--reuse-window' '--classic'\n\
             else\nprintf '%s\\n' \"$#\" \"$1\" \"$2\" > '{}'\nfi\n",
            capture_path.display()
        );
        fs::write(&launcher_path, script).expect("launcher");
        fs::set_permissions(&launcher_path, fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let adapter = CursorEditorAdapter::with_candidates(vec![launcher_path.clone()]);
        let editor = adapter.probe().await.expect("verified editor");

        let project_path = directory.path().join("项目 & ';$() folder\nline");
        fs::create_dir(&project_path).expect("project");
        let project_metadata = fs::metadata(&project_path).expect("project metadata");
        use std::os::unix::fs::MetadataExt;
        let project_identity = serde_json::json!({
            "scheme": "unix_dev_ino_v1",
            "device": project_metadata.dev(),
            "inode": project_metadata.ino(),
        })
        .to_string();
        adapter
            .open_directory(&editor, &project_path, &project_identity)
            .await
            .expect("open directory");
        for _ in 0..100 {
            if capture_path.is_file() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let captured = fs::read_to_string(&capture_path).expect("captured arguments");
        let mut lines = captured.lines();
        assert_eq!(lines.next(), Some("2"));
        assert_eq!(lines.next(), Some("--classic"));
        assert_eq!(
            lines.collect::<Vec<_>>().join("\n"),
            project_path.to_string_lossy()
        );

        let original_path = directory.path().join("original-project");
        let replacement_path = directory.path().join("replacement-project");
        fs::rename(&project_path, &original_path).expect("move original project");
        fs::create_dir(&replacement_path).expect("replacement project");
        std::os::unix::fs::symlink(&replacement_path, &project_path).expect("replacement symlink");
        let error = adapter
            .open_directory(&editor, &project_path, &project_identity)
            .await
            .expect_err("replaced project path rejected");
        assert_eq!(error.code, "cursor_project_identity_changed");
        fs::remove_file(&project_path).expect("remove replacement symlink");
        fs::rename(&original_path, &project_path).expect("restore original project");

        fs::write(&launcher_path, "#!/bin/sh\nprintf 'changed\\n'\n").expect("replace launcher");
        let error = adapter
            .open_directory(&editor, &project_path, &project_identity)
            .await
            .expect_err("changed launcher rejected");
        assert_eq!(error.code, "cursor_launcher_changed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_an_agent_cli_disguised_as_cursor() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("tempdir");
        let launcher_path = directory.path().join("cursor");
        fs::write(
            &launcher_path,
            "#!/bin/sh\nprintf '%s\\n' 'Usage: agent [options]' 'Cursor Agent CLI'\n",
        )
        .expect("launcher");
        fs::set_permissions(&launcher_path, fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let adapter = CursorEditorAdapter::with_candidates(vec![launcher_path]);

        let error = adapter
            .probe()
            .await
            .expect_err("agent CLI must be rejected");
        assert_eq!(error.code, "cursor_launcher_unverified");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_truncated_help_and_cleans_inherited_output_pipes() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("tempdir");
        let truncated_path = directory.path().join("cursor-truncated");
        fs::write(
            &truncated_path,
            "#!/bin/sh\nprintf '%s\\n' 'Usage: cursor [options] [paths...]' \
             '--new-window' '--reuse-window' '--classic'\n\
             i=0; while [ \"$i\" -lt 20000 ]; do printf x; i=$((i + 1)); done\n",
        )
        .expect("truncated launcher");
        fs::set_permissions(&truncated_path, fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let truncated = CursorEditorAdapter::with_candidates(vec![truncated_path]);
        assert_eq!(
            truncated
                .probe()
                .await
                .expect_err("truncated help rejected")
                .code,
            "cursor_launcher_unverified"
        );

        let inherited_pipe_path = directory.path().join("cursor-inherited-pipe");
        fs::write(
            &inherited_pipe_path,
            "#!/bin/sh\n(sleep 5) &\nprintf '%s\\n' 'Usage: cursor [options] [paths...]' \
             '--new-window' '--reuse-window' '--classic'\n",
        )
        .expect("inherited-pipe launcher");
        fs::set_permissions(&inherited_pipe_path, fs::Permissions::from_mode(0o700))
            .expect("permissions");
        let inherited_pipe = CursorEditorAdapter::with_candidates(vec![inherited_pipe_path]);
        let started = Instant::now();
        assert_eq!(
            inherited_pipe
                .probe()
                .await
                .expect_err("inherited output pipe rejected")
                .code,
            "cursor_launcher_unverified"
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        #[cfg(target_os = "linux")]
        {
            let child_pid_path = directory.path().join("background-pid");
            let redirected_path = directory.path().join("cursor-redirected-child");
            fs::write(
                &redirected_path,
                format!(
                    "#!/bin/sh\n(sleep 5 >/dev/null 2>&1) &\nprintf '%s' \"$!\" > '{}'\n\
                     printf '%s\\n' 'Usage: cursor [options] [paths...]' \
                     '--new-window' '--reuse-window' '--classic'\n",
                    child_pid_path.display()
                ),
            )
            .expect("redirected-child launcher");
            fs::set_permissions(&redirected_path, fs::Permissions::from_mode(0o700))
                .expect("permissions");
            assert_eq!(
                CursorEditorAdapter::with_candidates(vec![redirected_path])
                    .probe()
                    .await
                    .expect_err("redirected child rejected")
                    .code,
                "cursor_launcher_unverified"
            );
            let child_pid: u32 = fs::read_to_string(&child_pid_path)
                .expect("child pid")
                .parse()
                .expect("numeric child pid");
            let child_process = PathBuf::from(format!("/proc/{child_pid}"));
            for _ in 0..100 {
                if !child_process.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(!child_process.exists());
        }
    }
}
