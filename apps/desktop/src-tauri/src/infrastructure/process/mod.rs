use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::timeout;

use crate::domain::DomainError;
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

#[derive(Debug, Clone)]
pub struct ProcessRunner {
    policy: ProcessPolicy,
}

impl Default for ProcessRunner {
    fn default() -> Self {
        Self::new(ProcessPolicy::default())
    }
}

impl ProcessRunner {
    pub fn new(policy: ProcessPolicy) -> Self {
        Self { policy }
    }

    pub async fn run_omp(
        &self,
        executable: &Path,
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

        let mut command = Command::new(executable);
        command
            .args(probe_command.arguments())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        copy_allowlisted_environment(&mut command);

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
                let _ = child.kill().await;
                let _ = child.wait().await;
                let (stdout, stderr) = collect_output(stdout_task, stderr_task).await?;
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

        let (stdout, stderr) = collect_output(stdout_task, stderr_task).await?;
        Ok(OmpProcessOutput {
            exit_code: status.code(),
            success: status.success(),
            stdout_redacted: redact_bytes(&stdout.bytes),
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

async fn collect_output(
    stdout_task: tokio::task::JoinHandle<std::io::Result<BoundedOutput>>,
    stderr_task: tokio::task::JoinHandle<std::io::Result<BoundedOutput>>,
) -> Result<(BoundedOutput, BoundedOutput), DomainError> {
    let stdout = stdout_task.await.map_err(join_error)??;
    let stderr = stderr_task.await.map_err(join_error)??;
    Ok((stdout, stderr))
}

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
}
