use std::path::Path;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::domain::DomainError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Skip,
    Replace,
    KeepBoth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImporterCapabilities {
    pub can_detect_file: bool,
    pub can_detect_directory: bool,
    pub can_preview: bool,
    pub can_import: bool,
    pub can_resync: bool,
    pub source_is_read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportCandidate {
    pub provider: String,
    pub masked_identity: String,
    pub credential_type: String,
    pub expires_at_epoch_ms: Option<u64>,
    pub stable_identity_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportPreview {
    pub preview_id: String,
    pub adapter_id: String,
    pub source_label: String,
    pub candidates: Vec<ImportCandidate>,
    pub expires_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub replaced: u32,
    pub target_references: Vec<String>,
}

#[async_trait]
pub trait CredentialImporter: Send + Sync {
    fn adapter_id(&self) -> &'static str;

    fn capabilities(&self) -> ImporterCapabilities;

    async fn detect(&self, _source: &Path) -> Result<bool, DomainError> {
        Err(DomainError::unsupported("import_detect"))
    }

    async fn preview(&self, _source: &Path) -> Result<ImportPreview, DomainError> {
        Err(DomainError::unsupported("import_preview"))
    }

    async fn import(
        &self,
        _preview_id: &str,
        _target_profile: &str,
        _conflict_policy: ConflictPolicy,
    ) -> Result<ImportResult, DomainError> {
        Err(DomainError::unsupported("credential_import"))
    }

    async fn resync(&self, _source_id: &str) -> Result<ImportResult, DomainError> {
        Err(DomainError::unsupported("credential_resync"))
    }
}
