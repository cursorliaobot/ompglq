mod session_parser;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::adapters::targets::{ExecutionTarget, LocalTarget};
use crate::domain::{
    Capability, CapabilitySource, Diagnostic, DomainError, LaunchPlan, LaunchPlanInput,
    OmpInstallation, ProbeReport, ProbeStatus,
};
use crate::infrastructure::process::{
    resolve_executable_on_path, OmpProbeCommand, OmpProcessOutput,
};
use crate::infrastructure::secrets::redact;

pub use crate::domain::SessionReadStatus;
pub use session_parser::{
    parse_session_bytes, ParsedSession, ParsedSessionHeader, ParsedSessionMessage,
    SessionParseLimits,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OmpProfile {
    pub target_id: String,
    pub name: String,
    pub agent_directory: Option<String>,
    pub discovery_evidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OmpModel {
    pub provider: String,
    pub id: String,
    pub selector: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
    pub thinking: Option<Vec<String>>,
    pub input: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OmpSession {
    pub target_id: String,
    pub profile: Option<String>,
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub first_message_summary: Option<String>,
    pub created_at_epoch_ms: Option<u64>,
    pub modified_at_epoch_ms: u64,
    pub model_selector: Option<String>,
    pub provider: Option<String>,
    pub message_count: u64,
    pub size_bytes: u64,
    pub read_status: SessionReadStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OmpSessionPreview {
    pub session: OmpSession,
    pub messages: Vec<String>,
    pub skipped_record_count: u64,
    pub warning_codes: Vec<String>,
}

#[async_trait]
pub trait OmpAdapter: Send + Sync {
    async fn probe_capabilities(
        &self,
        requested_path: Option<&Path>,
    ) -> Result<ProbeReport, DomainError>;

    async fn list_profiles(
        &self,
        _installation: &OmpInstallation,
    ) -> Result<Vec<OmpProfile>, DomainError> {
        Err(DomainError::unsupported("omp_list_profiles"))
    }

    async fn list_models(
        &self,
        _installation: &OmpInstallation,
        _profile: &str,
        _project: &Path,
    ) -> Result<Vec<OmpModel>, DomainError> {
        Err(DomainError::unsupported("omp_list_models"))
    }

    async fn list_sessions(
        &self,
        _installation: &OmpInstallation,
        _profile: &str,
        _project: &Path,
    ) -> Result<Vec<OmpSession>, DomainError> {
        Err(DomainError::unsupported("omp_list_sessions"))
    }

    async fn preview_session(
        &self,
        _session: &OmpSession,
    ) -> Result<OmpSessionPreview, DomainError> {
        Err(DomainError::unsupported("omp_preview_session"))
    }

    async fn build_launch_plan(&self, _input: LaunchPlanInput) -> Result<LaunchPlan, DomainError> {
        Err(DomainError::unsupported("omp_build_launch_plan"))
    }

    async fn install(&self) -> Result<ProbeReport, DomainError> {
        Err(DomainError::unsupported("omp_install"))
    }

    async fn update(&self, _installation: &OmpInstallation) -> Result<ProbeReport, DomainError> {
        Err(DomainError::unsupported("omp_update"))
    }
}

#[derive(Debug, Clone, Default)]
pub struct CliOmpAdapter {
    target: LocalTarget,
}

impl CliOmpAdapter {
    pub fn new(target: LocalTarget) -> Self {
        Self { target }
    }
}

#[async_trait]
impl OmpAdapter for CliOmpAdapter {
    async fn probe_capabilities(
        &self,
        requested_path: Option<&Path>,
    ) -> Result<ProbeReport, DomainError> {
        let mut diagnostics = Vec::new();
        let candidates = discover_candidates(requested_path, &mut diagnostics);
        let mut selected = None;

        for candidate in candidates {
            let output = match self
                .target
                .run_omp(&candidate, OmpProbeCommand::Version)
                .await
            {
                Ok(output) => output,
                Err(error) => {
                    diagnostics.push(error.into());
                    continue;
                }
            };
            if !output.success {
                diagnostics.push(command_failure_diagnostic(
                    OmpProbeCommand::Version,
                    &output,
                ));
                continue;
            }
            if let Some(version) = parse_version(&output.stdout_redacted) {
                selected = Some((candidate, version));
                break;
            }
            diagnostics.push(Diagnostic::new(
                "omp_version_unrecognized",
                "候选 OMP 返回了无法识别的版本信息。",
                "选择有效的 OMP 可执行文件后重试。",
                true,
                "version output did not match omp/<version>",
            ));
        }

        let Some((executable, version)) = selected else {
            diagnostics.push(Diagnostic::new(
                "omp_not_found",
                "未找到可验证的 OMP 可执行文件。",
                "安装 OMP、选择其绝对路径，或将它加入 PATH 后重新检测。",
                true,
                "candidate discovery completed without a valid omp --version response",
            ));
            return Ok(ProbeReport {
                target_id: self.target.target_id().to_owned(),
                status: ProbeStatus::Missing,
                installation: None,
                capabilities: Vec::new(),
                diagnostics,
            });
        };

        let commands = [
            OmpProbeCommand::RootHelp,
            OmpProbeCommand::ConfigHelp,
            OmpProbeCommand::ModelsHelp,
            OmpProbeCommand::UsageHelp,
            OmpProbeCommand::AuthBrokerHelp,
            OmpProbeCommand::AuthGatewayHelp,
            OmpProbeCommand::UpdateHelp,
        ];
        let mut outputs = HashMap::new();
        for command in commands {
            match self.target.run_omp(&executable, command).await {
                Ok(output) if output.success => {
                    outputs.insert(command, output);
                }
                Ok(output) => diagnostics.push(command_failure_diagnostic(command, &output)),
                Err(error) => diagnostics.push(error.into()),
            }
        }

        let capabilities = map_capabilities(&outputs);
        let status = if [
            "profile",
            "cwd",
            "session_resume",
            "models_json",
            "config_json",
        ]
        .iter()
        .all(|id| {
            capabilities
                .iter()
                .any(|capability| capability.id == *id && capability.available)
        }) {
            ProbeStatus::Ready
        } else {
            ProbeStatus::Limited
        };
        let metadata = std::fs::metadata(&executable).ok();
        let installation = OmpInstallation {
            executable_path: executable.to_string_lossy().into_owned(),
            version,
            architecture: std::env::consts::ARCH.to_owned(),
            probed_at_epoch_ms: epoch_millis(SystemTime::now()),
            binary_modified_at_epoch_ms: metadata
                .and_then(|value| value.modified().ok())
                .map(epoch_millis),
        };

        Ok(ProbeReport {
            target_id: self.target.target_id().to_owned(),
            status,
            installation: Some(installation),
            capabilities,
            diagnostics,
        })
    }
}

fn discover_candidates(
    requested_path: Option<&Path>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<PathBuf> {
    let mut raw_candidates = Vec::new();
    if let Some(path) = requested_path {
        if path.is_absolute() {
            raw_candidates.push(path.to_owned());
        } else {
            diagnostics.push(Diagnostic::new(
                "omp_path_not_absolute",
                "所选 OMP 路径不是绝对路径。",
                "重新选择 OMP 可执行文件。",
                false,
                "requested_path was relative",
            ));
        }
    }
    if let Some(path) = resolve_executable_on_path("omp") {
        raw_candidates.push(path);
    }
    raw_candidates.extend(platform_candidates());

    let mut seen = HashSet::new();
    raw_candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
        .filter_map(|candidate| match std::fs::canonicalize(&candidate) {
            Ok(path) if seen.insert(path.clone()) => Some(path),
            Ok(_) => None,
            Err(error) => {
                diagnostics.push(Diagnostic::new(
                    "omp_path_unreadable",
                    "无法解析候选 OMP 路径。",
                    "检查文件权限或重新选择路径。",
                    true,
                    redact(&format!("path={} error={error}", candidate.display())),
                ));
                None
            }
        })
        .collect()
}

fn platform_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local").join("bin").join(executable_name()));
        candidates.push(home.join(".bun").join("bin").join(executable_name()));
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("omp")
                .join("omp.exe"),
        );
    }
    #[cfg(not(windows))]
    {
        candidates.push(PathBuf::from("/usr/local/bin/omp"));
        candidates.push(PathBuf::from("/usr/bin/omp"));
    }
    candidates
}

#[cfg(windows)]
fn executable_name() -> &'static str {
    "omp.exe"
}

#[cfg(not(windows))]
fn executable_name() -> &'static str {
    "omp"
}

fn parse_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("omp/")
            .filter(|version| !version.trim().is_empty())
            .map(str::to_owned)
    })
}

fn map_capabilities(outputs: &HashMap<OmpProbeCommand, OmpProcessOutput>) -> Vec<Capability> {
    let root = command_stdout(outputs, OmpProbeCommand::RootHelp);
    let config = command_stdout(outputs, OmpProbeCommand::ConfigHelp);
    let models = command_stdout(outputs, OmpProbeCommand::ModelsHelp);
    let usage = command_stdout(outputs, OmpProbeCommand::UsageHelp);
    let broker = command_stdout(outputs, OmpProbeCommand::AuthBrokerHelp);
    let gateway = command_stdout(outputs, OmpProbeCommand::AuthGatewayHelp);
    let update = command_stdout(outputs, OmpProbeCommand::UpdateHelp);

    vec![
        token_capability(
            "profile",
            CapabilitySource::Cli,
            root,
            &["--profile"],
            "omp --help advertises --profile",
        ),
        token_capability(
            "cwd",
            CapabilitySource::Cli,
            root,
            &["--cwd"],
            "omp --help advertises --cwd",
        ),
        token_capability(
            "session_resume",
            CapabilitySource::Cli,
            root,
            &["--resume"],
            "omp --help advertises --resume",
        ),
        token_capability(
            "session_fork",
            CapabilitySource::Cli,
            root,
            &["--fork"],
            "omp --help advertises --fork",
        ),
        token_capability(
            "session_export",
            CapabilitySource::Cli,
            root,
            &["--export"],
            "omp --help advertises --export",
        ),
        token_capability(
            "session_dir",
            CapabilitySource::Cli,
            root,
            &["--session-dir"],
            "omp --help advertises --session-dir",
        ),
        token_capability(
            "config_json",
            CapabilitySource::Cli,
            config,
            &["list", "--json"],
            "omp config --help advertises list --json",
        ),
        token_capability(
            "models_json",
            CapabilitySource::Cli,
            models,
            &["--json"],
            "omp models --help advertises --json",
        ),
        token_capability(
            "usage",
            CapabilitySource::Cli,
            usage,
            &["--json", "--redact"],
            "omp usage --help advertises --json and --redact",
        ),
        token_capability(
            "auth_broker",
            CapabilitySource::Broker,
            broker,
            &["status", "--json"],
            "omp auth-broker --help advertises status --json",
        ),
        token_capability(
            "auth_gateway",
            CapabilitySource::Gateway,
            gateway,
            &["check", "--json"],
            "omp auth-gateway --help advertises check --json",
        ),
        token_capability(
            "auth_gateway_strict",
            CapabilitySource::Gateway,
            gateway,
            &["check", "--strict"],
            "omp auth-gateway --help advertises strict check",
        ),
        token_capability(
            "update_check",
            CapabilitySource::Cli,
            update,
            &["--check"],
            "omp update --help advertises --check",
        ),
        Capability::unavailable(
            "credential_pin",
            "OMP 18.0.3 exposes no stable credential-pin launch argument",
        ),
        Capability::unavailable(
            "profile_discovery",
            "OMP 18.0.3 exposes no public profile-list command",
        ),
    ]
}

fn command_stdout(
    outputs: &HashMap<OmpProbeCommand, OmpProcessOutput>,
    command: OmpProbeCommand,
) -> Option<&str> {
    outputs
        .get(&command)
        .map(|output| output.stdout_redacted.as_str())
}

fn token_capability(
    id: &str,
    source: CapabilitySource,
    output: Option<&str>,
    required_tokens: &[&str],
    evidence: &str,
) -> Capability {
    if output.is_some_and(|value| required_tokens.iter().all(|token| value.contains(token))) {
        Capability::available(id, source, evidence)
    } else {
        Capability::unavailable(
            id,
            format!("required help evidence was not observed: {evidence}"),
        )
    }
}

fn command_failure_diagnostic(command: OmpProbeCommand, output: &OmpProcessOutput) -> Diagnostic {
    Diagnostic::new(
        "omp_probe_command_failed",
        "OMP 能力探测命令未成功完成。",
        "可重新检测；对应功能会保持禁用。",
        true,
        format!(
            "command={} exit_code={:?} stdout_truncated={} stderr_truncated={} stderr={}",
            command.id(),
            output.exit_code,
            output.stdout_truncated,
            output.stderr_truncated,
            output.stderr_redacted
        ),
    )
}

fn epoch_millis(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(stdout: &str) -> OmpProcessOutput {
        OmpProcessOutput {
            exit_code: Some(0),
            success: true,
            stdout_redacted: stdout.to_owned(),
            stderr_redacted: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    #[test]
    fn parses_only_non_empty_omp_versions() {
        assert_eq!(parse_version("omp/18.0.3\n"), Some("18.0.3".to_owned()));
        assert_eq!(parse_version("other/18.0.3\n"), None);
        assert_eq!(parse_version("omp/\n"), None);
    }

    #[test]
    fn capability_mapping_is_fail_closed() {
        let outputs = HashMap::from([
            (
                OmpProbeCommand::RootHelp,
                output("--profile --cwd --resume --export"),
            ),
            (OmpProbeCommand::ConfigHelp, output("list --json")),
            (OmpProbeCommand::ModelsHelp, output("--json")),
        ]);
        let capabilities = map_capabilities(&outputs);
        assert!(capabilities
            .iter()
            .any(|value| value.id == "profile" && value.available));
        assert!(capabilities
            .iter()
            .any(|value| value.id == "models_json" && value.available));
        assert!(capabilities
            .iter()
            .any(|value| value.id == "session_fork" && !value.available));
        assert!(capabilities
            .iter()
            .any(|value| value.id == "credential_pin" && !value.available));
    }
}
