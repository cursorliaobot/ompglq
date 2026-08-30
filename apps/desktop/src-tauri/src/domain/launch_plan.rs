use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::DomainError;

pub const LAUNCH_MODEL_ROLES: &[&str] = &["default", "smol", "slow", "plan"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchAction {
    New,
    Resume,
    Fork,
    Export,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalMode {
    Embedded,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CredentialPolicy {
    Automatic,
    Profile,
    CredentialPin { opaque_reference: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingSource {
    LaunchOverride,
    Session,
    Project,
    Profile,
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchModel {
    pub provider: String,
    pub id: String,
    pub selector: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
    pub thinking: Vec<String>,
    pub input: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchOptionsRequest {
    pub project_id: i64,
    pub expected_binding_revision: u64,
    pub action: LaunchAction,
    pub session_index_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchOptions {
    pub project_id: i64,
    pub binding_revision: u64,
    pub action: LaunchAction,
    pub session_index_id: Option<i64>,
    pub session_id: Option<String>,
    pub profile: String,
    pub cwd_display: String,
    pub model_roles: BTreeMap<String, String>,
    pub thinking_level: Option<String>,
    pub credential_policy: CredentialPolicy,
    pub terminal_mode: TerminalMode,
    pub available_models: Vec<LaunchModel>,
    pub warnings: Vec<String>,
    pub setting_sources: BTreeMap<String, SettingSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareLaunchPlanRequest {
    pub project_id: i64,
    pub expected_binding_revision: u64,
    pub action: LaunchAction,
    pub session_index_id: Option<i64>,
    pub model_roles: BTreeMap<String, String>,
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedLaunchPlan {
    pub plan_id: String,
    pub input_fingerprint: String,
    pub created_at_epoch_ms: u64,
    pub expires_at_epoch_ms: u64,
    pub project_id: i64,
    pub binding_revision: u64,
    pub action: LaunchAction,
    pub session_index_id: Option<i64>,
    pub session_id: Option<String>,
    pub profile: String,
    pub cwd_display: String,
    pub model_roles: BTreeMap<String, String>,
    pub thinking_level: Option<String>,
    pub credential_policy: CredentialPolicy,
    pub terminal_mode: TerminalMode,
    pub display_preview_redacted: String,
    pub environment: Vec<LaunchEnvironmentSummary>,
    pub warnings: Vec<String>,
    pub setting_sources: BTreeMap<String, SettingSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchEnvironmentSummary {
    pub name: String,
    pub source: LaunchEnvironmentSource,
    pub present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchEnvironmentSource {
    ManagerProcess,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecuteLaunchPlanRequest {
    pub plan_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LaunchExecutionResult {
    Embedded { run: PtyRunSnapshot },
    External { launch: ExternalTerminalLaunch },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalTerminalLaunch {
    pub terminal_id: String,
    pub process_id: Option<u32>,
    pub project_id: i64,
    pub action: LaunchAction,
    pub session_id: Option<String>,
    pub profile: String,
    pub model_roles: BTreeMap<String, String>,
    pub thinking_level: Option<String>,
    pub launched_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PtyRunStatus {
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyRunSnapshot {
    pub run_id: String,
    pub project_id: i64,
    pub action: LaunchAction,
    pub session_id: Option<String>,
    pub title: String,
    pub profile: String,
    pub model_roles: BTreeMap<String, String>,
    pub thinking_level: Option<String>,
    pub status: PtyRunStatus,
    pub process_id: Option<u32>,
    pub started_at_epoch_ms: u64,
    pub finished_at_epoch_ms: Option<u64>,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub first_available_sequence: u64,
    pub last_sequence: u64,
    pub output_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyOutputFrame {
    pub run_id: String,
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyOutputBatch {
    pub run: PtyRunSnapshot,
    pub frames: Vec<PtyOutputFrame>,
    pub gap_before_first_frame: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadPtyOutputRequest {
    pub run_id: String,
    pub after_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WritePtyInputRequest {
    pub run_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResizePtyRequest {
    pub run_id: String,
    pub rows: u16,
    pub cols: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminatePtyRequest {
    pub run_id: String,
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClosePtyRunRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchPlan {
    target_id: String,
    omp_executable: PathBuf,
    cwd: PathBuf,
    profile: String,
    action: LaunchAction,
    session_ref: Option<String>,
    model_roles: BTreeMap<String, String>,
    thinking_level: Option<String>,
    credential_policy: CredentialPolicy,
    terminal_mode: TerminalMode,
    args: Vec<String>,
    env_allowlist: Vec<String>,
    temporary_config: Option<PathBuf>,
    display_preview_redacted: String,
    warnings: Vec<String>,
    setting_sources: BTreeMap<String, SettingSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlanInput {
    pub target_id: String,
    pub omp_executable: PathBuf,
    pub cwd: PathBuf,
    pub profile: String,
    pub action: LaunchAction,
    pub session_ref: Option<String>,
    pub model_roles: BTreeMap<String, String>,
    pub thinking_level: Option<String>,
    pub credential_policy: CredentialPolicy,
    pub terminal_mode: TerminalMode,
    pub args: Vec<String>,
    pub env_allowlist: Vec<String>,
    pub temporary_config: Option<PathBuf>,
    pub display_preview_redacted: String,
    pub warnings: Vec<String>,
    pub setting_sources: BTreeMap<String, SettingSource>,
}

impl LaunchPlan {
    pub fn new(input: LaunchPlanInput) -> Result<Self, DomainError> {
        if input.target_id.trim().is_empty() {
            return Err(DomainError::new(
                "launch_plan_invalid_target",
                "启动计划缺少执行目标。",
                "重新检测 OMP 后再生成启动计划。",
                false,
                "target_id was empty",
            ));
        }
        if !input.omp_executable.is_absolute() || !input.cwd.is_absolute() {
            return Err(DomainError::new(
                "launch_plan_non_absolute_path",
                "启动计划包含非绝对路径。",
                "重新选择 OMP 可执行文件和项目目录。",
                false,
                "omp_executable and cwd must be absolute",
            ));
        }
        if !is_valid_profile(&input.profile) {
            return Err(DomainError::new(
                "launch_plan_invalid_profile",
                "启动计划包含无效的 OMP Profile。",
                "选择默认 Profile 或已验证的命名 Profile。",
                false,
                "profile did not satisfy the OMP profile-name contract",
            ));
        }
        if input.args.iter().any(|argument| argument.contains('\0')) {
            return Err(DomainError::new(
                "launch_plan_nul_argument",
                "启动参数包含操作系统不接受的空字符。",
                "移除无效字符后重试。",
                false,
                "an argument contained NUL",
            ));
        }
        if let Some((role, _selector)) = input
            .model_roles
            .iter()
            .find(|(_, selector)| !is_exact_model_selector(selector))
        {
            return Err(DomainError::new(
                "launch_plan_invalid_model_selector",
                "模型必须使用精确的 provider/modelId。",
                "从已探测的 OMP 模型列表重新选择。",
                false,
                format!("invalid selector for role {role}"),
            ));
        }

        Ok(Self {
            target_id: input.target_id,
            omp_executable: input.omp_executable,
            cwd: input.cwd,
            profile: input.profile,
            action: input.action,
            session_ref: input.session_ref,
            model_roles: input.model_roles,
            thinking_level: input.thinking_level,
            credential_policy: input.credential_policy,
            terminal_mode: input.terminal_mode,
            args: input.args,
            env_allowlist: input.env_allowlist,
            temporary_config: input.temporary_config,
            display_preview_redacted: input.display_preview_redacted,
            warnings: input.warnings,
            setting_sources: input.setting_sources,
        })
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    pub fn target_id(&self) -> &str {
        &self.target_id
    }

    pub fn omp_executable(&self) -> &std::path::Path {
        &self.omp_executable
    }

    pub fn cwd(&self) -> &std::path::Path {
        &self.cwd
    }

    pub fn profile(&self) -> &str {
        &self.profile
    }

    pub fn action(&self) -> LaunchAction {
        self.action
    }

    pub fn session_ref(&self) -> Option<&str> {
        self.session_ref.as_deref()
    }

    pub fn model_roles(&self) -> &BTreeMap<String, String> {
        &self.model_roles
    }

    pub fn thinking_level(&self) -> Option<&str> {
        self.thinking_level.as_deref()
    }

    pub fn credential_policy(&self) -> &CredentialPolicy {
        &self.credential_policy
    }

    pub fn terminal_mode(&self) -> TerminalMode {
        self.terminal_mode
    }

    pub fn env_allowlist(&self) -> &[String] {
        &self.env_allowlist
    }

    pub fn temporary_config(&self) -> Option<&std::path::Path> {
        self.temporary_config.as_deref()
    }

    pub fn display_preview_redacted(&self) -> &str {
        &self.display_preview_redacted
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn setting_sources(&self) -> &BTreeMap<String, SettingSource> {
        &self.setting_sources
    }
}

fn is_exact_model_selector(value: &str) -> bool {
    value.len() <= 768
        && value.trim() == value
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{202a}'
                        ..='\u{202e}' | '\u{2066}'
                        ..='\u{2069}'
                )
        })
        && value
            .split_once('/')
            .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty())
}

pub(crate) fn is_valid_profile(value: &str) -> bool {
    if value == "default" {
        return true;
    }
    if value.is_empty()
        || value.len() > 64
        || value == "."
        || value == ".."
        || value.ends_with('.')
        || !value.is_ascii()
    {
        return false;
    }
    let mut characters = value.bytes();
    if !characters
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || !characters.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return false;
    }
    let stem = value.split('.').next().unwrap_or_default();
    !matches!(stem, "con" | "prn" | "aux" | "nul")
        && !matches!(
            stem.as_bytes(),
            [b'c', b'o', b'm', b'0'..=b'9'] | [b'l', b'p', b't', b'0'..=b'9']
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_path_characters_remain_one_argument() {
        let dangerous = "/tmp/项目 & 'quoted'; $(touch nope)\nline".to_owned();
        let plan = LaunchPlan::new(LaunchPlanInput {
            target_id: "local".into(),
            omp_executable: PathBuf::from("/usr/bin/omp"),
            cwd: PathBuf::from("/tmp/项目"),
            profile: "default".into(),
            action: LaunchAction::New,
            session_ref: None,
            model_roles: BTreeMap::from([("default".into(), "provider/org/model".into())]),
            thinking_level: None,
            credential_policy: CredentialPolicy::Automatic,
            terminal_mode: TerminalMode::Embedded,
            args: vec!["--cwd".into(), dangerous.clone()],
            env_allowlist: Vec::new(),
            temporary_config: None,
            display_preview_redacted: "omp --cwd [path]".into(),
            warnings: Vec::new(),
            setting_sources: BTreeMap::new(),
        })
        .expect("dangerous shell characters are data in an argument array");

        assert_eq!(plan.args(), &["--cwd", dangerous.as_str()]);
    }

    #[test]
    fn accepts_nested_model_ids_and_rejects_invalid_profiles() {
        assert!(is_exact_model_selector("provider/organization/model"));
        assert!(!is_exact_model_selector("provider"));
        assert!(!is_exact_model_selector("provider/model\nspoofed"));
        assert!(!is_exact_model_selector("provider/\u{202e}model"));
        assert!(is_valid_profile("default"));
        assert!(is_valid_profile("work.profile-1"));
        assert!(!is_valid_profile("Work"));
        assert!(!is_valid_profile("con.txt"));
    }
}
