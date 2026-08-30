use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::timeout;
use uuid::Uuid;

use crate::domain::{DomainError, ExecutableIdentityEvidence};
use crate::infrastructure::secrets::{redact, redact_bytes};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OmpProbeCommand {
    Version,
    RootHelp,
    ConfigHelp,
    ModelsHelp,
    UsageHelp,
    AuthBrokerHelp,
    AuthGatewayHelp,
    UpdateHelp,
}

impl OmpProbeCommand {
    pub const fn arguments(self) -> &'static [&'static str] {
        match self {
            Self::Version => &["--version"],
            Self::RootHelp => &["--help"],
            Self::ConfigHelp => &["config", "--help"],
            Self::ModelsHelp => &["models", "--help"],
            Self::UsageHelp => &["usage", "--help"],
            Self::AuthBrokerHelp => &["auth-broker", "--help"],
            Self::AuthGatewayHelp => &["auth-gateway", "--help"],
            Self::UpdateHelp => &["update", "--help"],
        }
    }

    pub const fn id(self) -> &'static str {
        match self {
            Self::Version => "version",
            Self::RootHelp => "root_help",
            Self::ConfigHelp => "config_help",
            Self::ModelsHelp => "models_help",
            Self::UsageHelp => "usage_help",
            Self::AuthBrokerHelp => "auth_broker_help",
            Self::AuthGatewayHelp => "auth_gateway_help",
            Self::UpdateHelp => "update_help",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProcessPolicy {
    pub timeout: Duration,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
}

impl Default for ProcessPolicy {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(4),
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 32 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpProcessOutput {
    pub exit_code: Option<i32>,
    pub success: bool,
    pub stdout_redacted: String,
    pub stderr_redacted: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug)]
pub struct OmpJsonOutput {
    pub stdout: Vec<u8>,
    pub stderr_redacted: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ProcessRunner {
    policy: ProcessPolicy,
}

impl Default for ProcessRunner {
    fn default() -> Self {
        Self::new(ProcessPolicy::default())
    }
}

const MAXIMUM_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

pub struct OpenedExecutable {
    file: File,
    evidence: ExecutableIdentityEvidence,
    interpreter: Option<Box<OpenedExecutable>>,
}

impl OpenedExecutable {
    pub fn evidence(&self) -> &ExecutableIdentityEvidence {
        &self.evidence
    }

    pub fn command_path(&self) -> PathBuf {
        self.interpreter
            .as_deref()
            .unwrap_or(self)
            .self_command_path()
    }

    pub fn command_arguments(&self) -> Vec<PathBuf> {
        self.interpreter
            .as_ref()
            .map(|_| vec![self.self_command_path()])
            .unwrap_or_default()
    }

    pub fn parent_command_path(&self) -> PathBuf {
        self.interpreter
            .as_deref()
            .unwrap_or(self)
            .parent_self_command_path()
    }

    pub fn parent_command_arguments(&self) -> Vec<PathBuf> {
        self.interpreter
            .as_ref()
            .map(|_| vec![self.parent_self_command_path()])
            .unwrap_or_default()
    }

    fn self_command_path(&self) -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.evidence.canonical_path.clone()
        }
    }

    fn parent_self_command_path(&self) -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            PathBuf::from(format!(
                "/proc/{}/fd/{}",
                std::process::id(),
                self.file.as_raw_fd()
            ))
        }
        #[cfg(not(target_os = "linux"))]
        {
            self.evidence.canonical_path.clone()
        }
    }

    #[cfg(target_os = "linux")]
    pub fn configure_tokio_command(&self, command: &mut Command) {
        use std::os::fd::AsRawFd;

        let mut descriptors = vec![self.file.as_raw_fd()];
        if let Some(interpreter) = &self.interpreter {
            descriptors.push(interpreter.file.as_raw_fd());
        }
        unsafe {
            command.pre_exec(move || {
                for descriptor in &descriptors {
                    clear_close_on_exec(*descriptor)?;
                }
                Ok(())
            });
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn configure_tokio_command(&self, _command: &mut Command) {}
}

#[cfg(target_os = "linux")]
fn clear_close_on_exec(descriptor: std::os::fd::RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn inspect_executable_file(path: &Path) -> io::Result<ExecutableIdentityEvidence> {
    open_verified_executable(path).map(|opened| opened.evidence)
}

pub fn open_verified_executable(path: &Path) -> io::Result<OpenedExecutable> {
    open_verified_executable_inner(path, true)
}

fn open_verified_executable_inner(
    path: &Path,
    allow_shebang: bool,
) -> io::Result<OpenedExecutable> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable path was not absolute",
        ));
    }
    let canonical_path = std::fs::canonicalize(path)?;
    if canonical_path != path {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable path was not canonical",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let mut file = options.open(&canonical_path)?;
    let before = executable_identity_from_metadata(&canonical_path, &file.metadata()?, [0; 32])?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut prefix = Vec::with_capacity(512);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = std::io::Read::read(&mut file, &mut buffer)?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > MAXIMUM_EXECUTABLE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "executable exceeded the identity hashing limit",
            ));
        }
        if prefix.len() < 512 {
            let keep = (512 - prefix.len()).min(count);
            prefix.extend_from_slice(&buffer[..keep]);
        }
        hasher.update(&buffer[..count]);
    }
    let after_metadata = file.metadata()?;
    let path_metadata = std::fs::metadata(&canonical_path)?;
    let after = executable_identity_from_metadata(&canonical_path, &after_metadata, [0; 32])?;
    let path_after = executable_identity_from_metadata(&canonical_path, &path_metadata, [0; 32])?;
    if before != after || after != path_after || total != after.size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "executable identity changed while it was inspected",
        ));
    }
    let digest = hasher.finalize();
    let mut sha256 = [0_u8; 32];
    sha256.copy_from_slice(&digest);
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0))?;
    let interpreter = resolve_shebang_interpreter(&prefix)?
        .map(|path| {
            if !allow_shebang {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "OMP interpreter must be a native executable",
                ));
            }
            open_verified_executable_inner(&path, false).map(Box::new)
        })
        .transpose()?;
    let mut evidence = ExecutableIdentityEvidence { sha256, ..after };
    evidence.interpreter = interpreter
        .as_ref()
        .map(|interpreter| Box::new(interpreter.evidence.clone()));
    Ok(OpenedExecutable {
        file,
        evidence,
        interpreter,
    })
}

fn resolve_shebang_interpreter(prefix: &[u8]) -> io::Result<Option<PathBuf>> {
    if !prefix.starts_with(b"#!") {
        return Ok(None);
    }
    let line_end = prefix
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "shebang line was too long"))?;
    let line = std::str::from_utf8(&prefix[2..line_end])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "shebang was not UTF-8"))?;
    let tokens = line.split_whitespace().collect::<Vec<_>>();
    let interpreter = match tokens.as_slice() {
        ["/usr/bin/env", "bun"] | ["/usr/bin/env", "-S", "bun"] => {
            resolve_executable_on_path("bun").ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "OMP requires bun but it was not found on PATH",
                )
            })?
        }
        [path]
            if Path::new(path).is_absolute()
                && Path::new(path).file_name() == Some(OsStr::new("bun")) =>
        {
            PathBuf::from(path)
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "OMP shebang did not name the supported bun interpreter",
            ));
        }
    };
    Ok(Some(std::fs::canonicalize(interpreter)?))
}

fn executable_identity_from_metadata(
    canonical_path: &Path,
    metadata: &std::fs::Metadata,
    sha256: [u8; 32],
) -> io::Result<ExecutableIdentityEvidence> {
    if !metadata.is_file() || metadata.len() > MAXIMUM_EXECUTABLE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "executable was not a bounded regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "executable permission bits were absent",
            ));
        }
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(ExecutableIdentityEvidence {
        canonical_path: canonical_path.to_owned(),
        size: metadata.len(),
        modified_at_epoch_nanos: metadata.modified().ok().and_then(system_time_nanos),
        sha256,
        interpreter: None,
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
    })
}

fn system_time_nanos(value: SystemTime) -> Option<u128> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos())
}

struct IsolatedModelHome {
    root: PathBuf,
}

impl IsolatedModelHome {
    fn create() -> io::Result<Self> {
        let root = std::env::temp_dir().join(format!("omp-manager-models-{}", Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { root })
    }

    fn configure(&self, command: &mut Command) {
        for name in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "PI_CODING_AGENT_DIR",
        ] {
            command.env(name, &self.root);
        }
    }
}

impl Drop for IsolatedModelHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl ProcessRunner {
    pub fn new(policy: ProcessPolicy) -> Self {
        Self { policy }
    }

    pub async fn run_omp(
        &self,
        executable: &Path,
        expected_identity: &ExecutableIdentityEvidence,
        probe_command: OmpProbeCommand,
    ) -> Result<OmpProcessOutput, DomainError> {
        if !executable.is_absolute() {
            return Err(DomainError::new(
                "omp_executable_not_absolute",
                "OMP 可执行文件必须是绝对路径。",
                "重新选择 OMP 可执行文件。",
                false,
                "the process boundary rejected a non-absolute executable",
            ));
        }

        let opened = open_verified_executable(executable).map_err(|error| {
            DomainError::new(
                "omp_executable_identity_changed",
                "OMP 可执行文件在检测期间发生变化。",
                "停止更新 OMP 后重新检测。",
                true,
                redact(&error.to_string()),
            )
        })?;
        if opened.evidence() != expected_identity {
            return Err(DomainError::new(
                "omp_executable_identity_changed",
                "OMP 可执行文件在检测期间发生变化。",
                "停止更新 OMP 后重新检测。",
                true,
                "opened executable identity differed from probe baseline",
            ));
        }
        let mut command = Command::new(opened.command_path());
        opened.configure_tokio_command(&mut command);
        command
            .args(opened.command_arguments())
            .args(probe_command.arguments())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        copy_allowlisted_environment(&mut command);
        isolate_process_group(&mut command);

        let mut child = command.spawn().map_err(|error| {
            DomainError::new(
                "omp_process_spawn_failed",
                "无法启动所选 OMP 可执行文件。",
                "检查文件权限和安装完整性后重试。",
                true,
                redact(&format!(
                    "command={} executable={} error={error}",
                    probe_command.id(),
                    executable.display()
                )),
            )
        })?;
        let process_id = child.id();

        let stdout = child.stdout.take().ok_or_else(|| {
            DomainError::new(
                "omp_stdout_unavailable",
                "无法读取 OMP 标准输出。",
                "重新检测 OMP。",
                true,
                "stdout pipe was unavailable",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            DomainError::new(
                "omp_stderr_unavailable",
                "无法读取 OMP 标准错误输出。",
                "重新检测 OMP。",
                true,
                "stderr pipe was unavailable",
            )
        })?;

        let stdout_task = tokio::spawn(read_bounded(stdout, self.policy.max_stdout_bytes));
        let stderr_task = tokio::spawn(read_bounded(stderr, self.policy.max_stderr_bytes));

        let status = match timeout(self.policy.timeout, child.wait()).await {
            Ok(result) => result.map_err(|error| {
                DomainError::new(
                    "omp_process_wait_failed",
                    "等待 OMP 探测命令结束时失败。",
                    "重新检测 OMP。",
                    true,
                    redact(&format!("command={} error={error}", probe_command.id())),
                )
            })?,
            Err(_) => {
                terminate_command_tree(&mut child, process_id).await;
                let (stdout, stderr) =
                    collect_output_with_deadline(stdout_task, stderr_task).await?;
                return Err(DomainError::new(
                    "omp_process_timeout",
                    "OMP 探测命令超时。",
                    "检查 OMP 安装状态后重试。",
                    true,
                    format!(
                        "command={} timeout_ms={} stdout={} stderr={}",
                        probe_command.id(),
                        self.policy.timeout.as_millis(),
                        redact_bytes(&stdout.bytes),
                        redact_bytes(&stderr.bytes)
                    ),
                ));
            }
        };

        terminate_process_group_after_exit(process_id);
        let (stdout, stderr) = collect_output_with_deadline(stdout_task, stderr_task).await?;
        Ok(OmpProcessOutput {
            exit_code: status.code(),
            success: status.success(),
            stdout_redacted: redact_bytes(&stdout.bytes),
            stderr_redacted: redact_bytes(&stderr.bytes),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
        })
    }

    pub async fn run_omp_models_json(
        &self,
        executable: &Path,
        expected_identity: &ExecutableIdentityEvidence,
        profile: &str,
        project: &Path,
    ) -> Result<OmpJsonOutput, DomainError> {
        if !executable.is_absolute() || !project.is_absolute() {
            return Err(DomainError::new(
                "omp_models_path_invalid",
                "OMP 模型查询需要绝对的程序和项目路径。",
                "重新检测 OMP 并刷新项目后重试。",
                false,
                "models query rejected a non-absolute path",
            ));
        }
        if !crate::domain::is_valid_profile(profile) {
            return Err(DomainError::new(
                "omp_models_profile_invalid",
                "OMP 模型查询包含无效 Profile。",
                "刷新项目绑定后重试。",
                false,
                "models query rejected an invalid profile",
            ));
        }

        let opened = open_verified_executable(executable).map_err(|error| {
            DomainError::new(
                "omp_models_executable_identity_changed",
                "OMP 可执行文件在模型查询前发生变化。",
                "重新检测 OMP 后再刷新模型。",
                true,
                redact(&format!("stage=models_identity; error={error}")),
            )
        })?;
        if opened.evidence() != expected_identity {
            return Err(DomainError::new(
                "omp_models_executable_identity_changed",
                "OMP 可执行文件在模型查询前发生变化。",
                "重新检测 OMP 后再刷新模型。",
                true,
                "opened executable identity differed from probe baseline",
            ));
        }
        let isolated_home = IsolatedModelHome::create().map_err(|error| {
            DomainError::new(
                "omp_models_isolation_failed",
                "无法为 OMP 模型查询创建隔离环境。",
                "检查临时目录权限后重试；仍可使用 OMP 默认模型启动。",
                true,
                redact(&format!("stage=models_isolation; error={error}")),
            )
        })?;
        let mut command = Command::new(opened.command_path());
        opened.configure_tokio_command(&mut command);
        command
            .args(opened.command_arguments())
            .args(["--profile", profile, "models", "--json", "--no-extensions"])
            .current_dir(&isolated_home.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        copy_allowlisted_environment(&mut command);
        isolated_home.configure(&mut command);
        isolate_process_group(&mut command);

        let mut child = command.spawn().map_err(|error| {
            DomainError::new(
                "omp_models_spawn_failed",
                "无法启动 OMP 模型查询。",
                "重新检测 OMP；若问题持续，请检查安装权限。",
                true,
                redact(&format!(
                    "stage=models_query; executable={} error={error}",
                    executable.display()
                )),
            )
        })?;
        let process_id = child.id();
        let stdout = child.stdout.take().ok_or_else(|| {
            DomainError::new(
                "omp_models_stdout_unavailable",
                "无法读取 OMP 模型查询输出。",
                "重新检测 OMP 后重试。",
                true,
                "models query stdout pipe was unavailable",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            DomainError::new(
                "omp_models_stderr_unavailable",
                "无法读取 OMP 模型查询错误输出。",
                "重新检测 OMP 后重试。",
                true,
                "models query stderr pipe was unavailable",
            )
        })?;
        let stdout_task = tokio::spawn(read_bounded(stdout, 2 * 1024 * 1024));
        let stderr_task = tokio::spawn(read_bounded(stderr, 64 * 1024));
        let status = match timeout(Duration::from_secs(15), child.wait()).await {
            Ok(result) => result.map_err(|error| {
                DomainError::new(
                    "omp_models_wait_failed",
                    "等待 OMP 模型查询结束时失败。",
                    "重新检测 OMP 后重试。",
                    true,
                    redact(&format!("stage=models_query; error={error}")),
                )
            })?,
            Err(_) => {
                terminate_command_tree(&mut child, process_id).await;
                let (stdout, stderr) =
                    collect_output_with_deadline(stdout_task, stderr_task).await?;
                return Err(DomainError::new(
                    "omp_models_timeout",
                    "OMP 模型查询超时。",
                    "检查 OMP 配置后重试。",
                    true,
                    format!(
                        "stage=models_query; timeout_ms=15000 stdout={} stderr={}",
                        redact_bytes(&stdout.bytes),
                        redact_bytes(&stderr.bytes)
                    ),
                ));
            }
        };
        terminate_process_group_after_exit(process_id);
        let (stdout, stderr) = collect_output_with_deadline(stdout_task, stderr_task).await?;
        if !status.success() {
            return Err(DomainError::new(
                "omp_models_failed",
                "OMP 未能列出当前 Profile 的模型。",
                "检查 Profile 配置和凭证后重试；仍可使用 OMP 默认模型启动。",
                true,
                format!(
                    "stage=models_query; exit_code={:?} stdout_truncated={} stderr_truncated={} stderr={}",
                    status.code(),
                    stdout.truncated,
                    stderr.truncated,
                    redact_bytes(&stderr.bytes)
                ),
            ));
        }
        Ok(OmpJsonOutput {
            stdout: stdout.bytes,
            stderr_redacted: redact_bytes(&stderr.bytes),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
        })
    }
}

#[derive(Debug)]
struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_bounded<R>(mut reader: R, maximum: usize) -> std::io::Result<BoundedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(maximum.min(8 * 1024));
    let mut buffer = [0_u8; 4 * 1024];
    let mut truncated = false;

    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = maximum.saturating_sub(retained.len());
        let keep = remaining.min(count);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }

    Ok(BoundedOutput {
        bytes: retained,
        truncated,
    })
}

async fn collect_output_with_deadline(
    mut stdout_task: tokio::task::JoinHandle<std::io::Result<BoundedOutput>>,
    mut stderr_task: tokio::task::JoinHandle<std::io::Result<BoundedOutput>>,
) -> Result<(BoundedOutput, BoundedOutput), DomainError> {
    match timeout(Duration::from_secs(2), async {
        let stdout = (&mut stdout_task).await.map_err(join_error)??;
        let stderr = (&mut stderr_task).await.map_err(join_error)??;
        Ok::<_, DomainError>((stdout, stderr))
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            Err(DomainError::new(
                "omp_output_drain_timeout",
                "OMP 子进程退出后仍有输出管道未关闭。",
                "结束残留的 OMP 子进程后重新检测。",
                true,
                "stdout or stderr remained open after the bounded drain deadline",
            ))
        }
    }
}

#[cfg(unix)]
fn isolate_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
fn isolate_process_group(_command: &mut Command) {}

async fn terminate_command_tree(child: &mut tokio::process::Child, process_id: Option<u32>) {
    #[cfg(unix)]
    if let Some(process_id) = process_id.and_then(|value| libc::pid_t::try_from(value).ok()) {
        let _ = unsafe { libc::kill(-process_id, libc::SIGKILL) };
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(unix)]
fn terminate_process_group_after_exit(process_id: Option<u32>) {
    if let Some(process_id) = process_id.and_then(|value| libc::pid_t::try_from(value).ok()) {
        let _ = unsafe { libc::kill(-process_id, libc::SIGKILL) };
    }
}

#[cfg(not(unix))]
fn terminate_process_group_after_exit(_process_id: Option<u32>) {}

fn join_error(error: tokio::task::JoinError) -> DomainError {
    DomainError::new(
        "omp_output_task_failed",
        "读取 OMP 探测输出时失败。",
        "重新检测 OMP。",
        true,
        redact(&error.to_string()),
    )
}

impl From<std::io::Error> for DomainError {
    fn from(error: std::io::Error) -> Self {
        DomainError::new(
            "omp_output_read_failed",
            "读取 OMP 探测输出时失败。",
            "重新检测 OMP。",
            true,
            redact(&error.to_string()),
        )
    }
}

fn copy_allowlisted_environment(command: &mut Command) {
    const ALLOWED: &[&str] = &[
        "PATH",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ];
    for name in ALLOWED {
        if let Some(value) = std::env::var_os(name) {
            command.env(OsStr::new(name), value);
        }
    }
}

pub fn omp_runtime_environment_names() -> &'static [&'static str] {
    &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "COLORTERM",
        "SHELL",
        "USER",
        "LOGNAME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ]
}

pub fn omp_launch_environment_names() -> &'static [&'static str] {
    &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "COLORTERM",
        "SHELL",
        "USER",
        "LOGNAME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_FOUNDRY",
        "FOUNDRY_BASE_URL",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_CLIENT_CERT",
        "CLAUDE_CODE_CLIENT_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "COPILOT_GITHUB_TOKEN",
        "AZURE_OPENAI_API_KEY",
        "GROQ_API_KEY",
        "CEREBRAS_API_KEY",
        "XAI_API_KEY",
        "OPENROUTER_API_KEY",
        "KILO_API_KEY",
        "MISTRAL_API_KEY",
        "ZAI_API_KEY",
        "UMANS_AI_CODING_PLAN_API_KEY",
        "MINIMAX_API_KEY",
        "OPENCODE_API_KEY",
        "CURSOR_ACCESS_TOKEN",
        "AI_GATEWAY_API_KEY",
        "WAFER_SERVERLESS_API_KEY",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ]
}

pub fn external_terminal_environment_names() -> &'static [&'static str] {
    &[
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "DESKTOP_STARTUP_ID",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "XDG_SESSION_TYPE",
    ]
}

pub fn provider_credential_environment_names(provider: &str) -> &'static [&'static str] {
    match provider {
        "anthropic" => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_OAUTH_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CODE_CLIENT_CERT",
            "CLAUDE_CODE_CLIENT_KEY",
        ],
        "anthropic-foundry" | "foundry" => &[
            "CLAUDE_CODE_USE_FOUNDRY",
            "FOUNDRY_BASE_URL",
            "ANTHROPIC_FOUNDRY_API_KEY",
        ],
        "openai" | "openai-codex" => &["OPENAI_API_KEY"],
        "google" | "gemini" | "google-vertex" => &[
            "GEMINI_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_APPLICATION_CREDENTIALS",
        ],
        "github-copilot" | "copilot" => &["COPILOT_GITHUB_TOKEN"],
        "azure-openai" | "azure" => &["AZURE_OPENAI_API_KEY"],
        "groq" => &["GROQ_API_KEY"],
        "cerebras" => &["CEREBRAS_API_KEY"],
        "xai" => &["XAI_API_KEY"],
        "openrouter" => &["OPENROUTER_API_KEY"],
        "kilo" => &["KILO_API_KEY"],
        "mistral" => &["MISTRAL_API_KEY"],
        "zai" => &["ZAI_API_KEY"],
        "umans" => &["UMANS_AI_CODING_PLAN_API_KEY"],
        "minimax" => &["MINIMAX_API_KEY"],
        "opencode" => &["OPENCODE_API_KEY"],
        "cursor" => &["CURSOR_ACCESS_TOKEN"],
        "ai-gateway" => &["AI_GATEWAY_API_KEY"],
        "wafer" | "wafer-serverless" => &["WAFER_SERVERLESS_API_KEY"],
        "amazon-bedrock" | "bedrock" => &[
            "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
        ],
        _ => &[],
    }
}

pub fn resolve_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names = executable_names(name);
    std::env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn executable_names(name: &str) -> Vec<String> {
    vec![format!("{name}.exe"), name.to_owned()]
}

#[cfg(not(windows))]
fn executable_names(name: &str) -> Vec<String> {
    vec![name.to_owned()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_commands_are_a_closed_argument_allowlist() {
        assert_eq!(OmpProbeCommand::Version.arguments(), ["--version"]);
        assert_eq!(
            OmpProbeCommand::AuthGatewayHelp.arguments(),
            ["auth-gateway", "--help"]
        );
        for command in [
            OmpProbeCommand::Version,
            OmpProbeCommand::RootHelp,
            OmpProbeCommand::ConfigHelp,
            OmpProbeCommand::ModelsHelp,
            OmpProbeCommand::UsageHelp,
            OmpProbeCommand::AuthBrokerHelp,
            OmpProbeCommand::AuthGatewayHelp,
            OmpProbeCommand::UpdateHelp,
        ] {
            assert!(command
                .arguments()
                .iter()
                .all(|argument| !argument.contains([';', '&', '\n'])));
        }
    }

    #[test]
    fn launch_environment_excludes_behavior_overrides_and_scopes_credentials() {
        for name in [
            "OMP_PROFILE",
            "PI_PROFILE",
            "PI_CODING_AGENT_DIR",
            "PI_PACKAGE_DIR",
            "PI_SMOL_MODEL",
            "PI_SLOW_MODEL",
            "PI_PLAN_MODEL",
            "PI_NO_PTY",
        ] {
            assert!(!omp_launch_environment_names().contains(&name));
        }
        assert_eq!(
            provider_credential_environment_names("openai"),
            ["OPENAI_API_KEY"]
        );
        assert!(provider_credential_environment_names("unknown").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn executable_identity_hashes_content_in_addition_to_metadata() {
        use std::io::{Seek, SeekFrom, Write as _};
        use std::os::unix::fs::PermissionsExt;

        let mut executable = tempfile::NamedTempFile::new().expect("temporary executable");
        executable.write_all(b"alpha").expect("write first content");
        executable.flush().expect("flush first content");
        std::fs::set_permissions(executable.path(), std::fs::Permissions::from_mode(0o700))
            .expect("mark executable");
        let path = std::fs::canonicalize(executable.path()).expect("canonical path");
        let first = inspect_executable_file(&path).expect("first identity");

        executable
            .as_file_mut()
            .seek(SeekFrom::Start(0))
            .expect("rewind");
        executable
            .as_file_mut()
            .write_all(b"bravo")
            .expect("replace content");
        executable.as_file_mut().flush().expect("flush replacement");
        let second = inspect_executable_file(&path).expect("second identity");

        assert_ne!(first.sha256, second.sha256);
    }

    #[cfg(unix)]
    #[test]
    fn executable_identity_pins_the_supported_bun_shebang_chain() {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory");
        let bun = directory.path().join("bun");
        let omp = directory.path().join("omp");
        std::fs::write(&bun, b"native-placeholder").expect("write bun");
        let mut script = File::create(&omp).expect("create OMP script");
        writeln!(script, "#!{}", bun.display()).expect("write shebang");
        writeln!(script, "placeholder").expect("write script");
        for path in [&bun, &omp] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .expect("mark executable");
        }

        let omp = std::fs::canonicalize(omp).expect("canonical OMP");
        let bun = std::fs::canonicalize(bun).expect("canonical bun");
        let opened = open_verified_executable(&omp).expect("open executable chain");
        assert_eq!(
            opened
                .evidence()
                .interpreter
                .as_deref()
                .map(|identity| identity.canonical_path.as_path()),
            Some(bun.as_path())
        );
        assert_eq!(opened.command_arguments().len(), 1);
    }
}
