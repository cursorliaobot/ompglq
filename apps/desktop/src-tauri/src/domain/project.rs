use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{Diagnostic, SettingSource, TerminalMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountPolicy {
    Automatic,
    Profile,
    CredentialPin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalEditorId {
    Cursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddProjectRequest {
    pub profile: String,
    pub terminal_mode: TerminalMode,
    pub account_policy: AccountPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProjectBindingRequest {
    pub project_id: i64,
    pub expected_revision: u64,
    pub profile: String,
    pub terminal_mode: TerminalMode,
    pub account_policy: AccountPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenProjectInEditorRequest {
    pub project_id: i64,
    pub editor_id: ExternalEditorId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenProjectInEditorResult {
    pub project_id: i64,
    pub editor_id: ExternalEditorId,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGitIdentity {
    pub common_directory: String,
    pub repository_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectBinding {
    pub id: i64,
    pub revision: u64,
    pub path_prefix: String,
    pub profile: String,
    pub profile_source: SettingSource,
    pub terminal_mode: TerminalMode,
    pub terminal_mode_source: SettingSource,
    pub account_policy: AccountPolicy,
    pub account_policy_source: SettingSource,
    pub role_defaults: BTreeMap<String, String>,
    pub allowed_models: Vec<String>,
    pub disabled_providers: Vec<String>,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: i64,
    pub target_id: String,
    pub canonical_path: String,
    pub display_path: String,
    pub git_identity: Option<ProjectGitIdentity>,
    pub created_at_epoch_ms: u64,
    pub last_used_at_epoch_ms: u64,
    pub authorization_status: ProjectAuthorizationStatus,
    pub binding: ProjectBinding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectAuthorizationStatus {
    Active,
    Offline,
    Replaced,
    Revoked,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownProfileSource {
    Default,
    ProjectBinding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownProfile {
    pub name: String,
    pub source: KnownProfileSource,
    pub agent_directory: Option<String>,
    pub is_complete_inventory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectWorkspaceSnapshot {
    pub projects: Vec<ProjectSummary>,
    pub known_profiles: Vec<KnownProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddProjectResult {
    pub project: ProjectSummary,
    pub diagnostics: Vec<Diagnostic>,
}
