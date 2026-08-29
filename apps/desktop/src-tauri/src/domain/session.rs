use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::Diagnostic;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionReadStatus {
    Readable,
    Partial,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionFreshness {
    Fresh,
    Stale,
    Missing,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileSessionRootStatus {
    Unconfigured,
    Active,
    Offline,
    Replaced,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSessionSummary {
    pub session_index_id: i64,
    pub session_id: String,
    pub project_id: i64,
    pub profile: String,
    pub title: String,
    pub cwd_display: String,
    pub modified_at_epoch_ms: u64,
    pub created_at_epoch_ms: Option<u64>,
    pub read_status: SessionReadStatus,
    pub freshness: SessionFreshness,
    pub model_selector: Option<String>,
    pub provider: Option<String>,
    pub credential_providers: Vec<String>,
    pub message_count: u64,
    pub size_bytes: u64,
    pub warning_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSessionsSnapshot {
    pub project_id: i64,
    pub profile: String,
    pub profile_inventory_complete: bool,
    pub root_status: ProfileSessionRootStatus,
    pub last_scanned_at_epoch_ms: Option<u64>,
    pub sessions: Vec<ProjectSessionSummary>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSessionPreviewRequest {
    pub project_id: i64,
    pub session_index_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSessionPreviewMessage {
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSessionPreview {
    pub project_id: i64,
    pub session_index_id: i64,
    pub profile: String,
    pub session_id: String,
    pub title: String,
    pub cwd_display: String,
    pub read_status: SessionReadStatus,
    pub model_selector: Option<String>,
    pub provider: Option<String>,
    pub model_roles: BTreeMap<String, String>,
    pub last_model_role: Option<String>,
    pub thinking_level: Option<String>,
    pub credential_providers: Vec<String>,
    pub message_count: u64,
    pub first_message_summary: Option<String>,
    pub messages: Vec<ProjectSessionPreviewMessage>,
    pub skipped_record_count: u64,
    pub warning_codes: Vec<String>,
    pub source_modified_at_epoch_ms: u64,
    pub source_size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::ProjectSessionPreviewRequest;

    #[test]
    fn preview_request_rejects_unknown_fields() {
        let error = serde_json::from_value::<ProjectSessionPreviewRequest>(serde_json::json!({
            "project_id": 1,
            "session_index_id": 2,
            "path": "/not/accepted",
        }))
        .expect_err("unknown path field rejected");
        assert!(error.to_string().contains("unknown field"));
    }
}
