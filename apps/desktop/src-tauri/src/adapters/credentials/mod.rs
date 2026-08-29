use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::domain::DomainError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialHealth {
    Unknown,
    Available,
    Expiring,
    Expired,
    Disabled,
    Backoff,
    Failed,
    SourceUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialReference {
    pub target_id: String,
    pub profile: String,
    pub opaque_reference: String,
    pub provider: String,
    pub masked_identity: String,
    pub credential_type: String,
    pub source: String,
    pub health: CredentialHealth,
    pub expires_at_epoch_ms: Option<u64>,
    pub last_checked_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialBackendCapabilities {
    pub can_list: bool,
    pub can_login: bool,
    pub can_disable: bool,
    pub can_delete: bool,
    pub can_pin: bool,
    pub can_safe_check: bool,
    pub can_strict_check: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialOperationResult {
    pub accepted: bool,
    pub requires_interactive_flow: bool,
    pub diagnostic_code: Option<String>,
}

#[async_trait]
pub trait CredentialBackend: Send + Sync {
    fn capabilities(&self) -> CredentialBackendCapabilities;

    async fn list(
        &self,
        _target_id: &str,
        _profile: &str,
    ) -> Result<Vec<CredentialReference>, DomainError> {
        Err(DomainError::unsupported("credential_list"))
    }

    async fn login(
        &self,
        _target_id: &str,
        _profile: &str,
    ) -> Result<CredentialOperationResult, DomainError> {
        Err(DomainError::unsupported("credential_login"))
    }

    async fn disable(
        &self,
        _reference: &CredentialReference,
    ) -> Result<CredentialOperationResult, DomainError> {
        Err(DomainError::unsupported("credential_disable"))
    }

    async fn delete(
        &self,
        _reference: &CredentialReference,
    ) -> Result<CredentialOperationResult, DomainError> {
        Err(DomainError::unsupported("credential_delete"))
    }

    async fn check(
        &self,
        _reference: &CredentialReference,
        _strict: bool,
    ) -> Result<CredentialOperationResult, DomainError> {
        Err(DomainError::unsupported("credential_check"))
    }
}
