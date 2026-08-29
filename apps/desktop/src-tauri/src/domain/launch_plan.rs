use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::DomainError;

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
}

fn is_exact_model_selector(value: &str) -> bool {
    value
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
        assert!(is_valid_profile("default"));
        assert!(is_valid_profile("work.profile-1"));
        assert!(!is_valid_profile("Work"));
        assert!(!is_valid_profile("con.txt"));
    }
}
