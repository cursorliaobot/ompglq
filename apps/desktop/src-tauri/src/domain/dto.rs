use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeStatus {
    Missing,
    Ready,
    Limited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeReport {
    pub target_id: String,
    pub status: ProbeStatus,
    pub installation: Option<OmpInstallation>,
    pub capabilities: Vec<Capability>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OmpInstallation {
    pub executable_path: String,
    pub version: String,
    pub architecture: String,
    pub probed_at_epoch_ms: u64,
    pub binary_modified_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySource {
    Cli,
    Broker,
    Gateway,
    Interactive,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub id: String,
    pub available: bool,
    pub source: CapabilitySource,
    pub evidence: String,
}

impl Capability {
    pub fn available(
        id: impl Into<String>,
        source: CapabilitySource,
        evidence: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            available: true,
            source,
            evidence: evidence.into(),
        }
    }

    pub fn unavailable(id: impl Into<String>, evidence: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            available: false,
            source: CapabilitySource::Unavailable,
            evidence: evidence.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub suggestion: String,
    pub retryable: bool,
    pub technical_detail_redacted: String,
}

impl Diagnostic {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        suggestion: impl Into<String>,
        retryable: bool,
        technical_detail_redacted: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            suggestion: suggestion.into(),
            retryable,
            technical_detail_redacted: technical_detail_redacted.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseAvailability {
    Initializing,
    Ready,
    RecoveryRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseStatusReport {
    pub revision: u64,
    pub availability: DatabaseAvailability,
    pub can_retry: bool,
    pub database_path: Option<String>,
    pub schema_version: Option<u32>,
    pub applied_migrations: Vec<u32>,
    pub migration_backup_path: Option<String>,
    pub diagnostic: Option<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtySpikeReport {
    pub ok: bool,
    pub marker: String,
    pub exit_code: u32,
    pub resized: bool,
    pub output_redacted: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_status_uses_the_bounded_snake_case_wire_contract() {
        let value = serde_json::to_value(DatabaseStatusReport {
            revision: 1,
            availability: DatabaseAvailability::Initializing,
            can_retry: false,
            database_path: Some("/app-data/metadata.sqlite3".to_owned()),
            schema_version: None,
            applied_migrations: Vec::new(),
            migration_backup_path: None,
            diagnostic: None,
        })
        .expect("serialize database status");

        assert_eq!(value["availability"], "initializing");
        assert_eq!(value["can_retry"], false);
        assert_eq!(value["database_path"], "/app-data/metadata.sqlite3");
    }
}
