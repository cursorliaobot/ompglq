use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::domain::{
    Diagnostic, DomainError, ExecutableIdentityEvidence, LaunchPlan, PtySpikeReport,
};
use crate::infrastructure::process::{OmpJsonOutput, OmpProbeCommand, OmpProcessOutput};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetHealth {
    pub target_id: String,
    pub healthy: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitIdentity {
    pub common_directory: PathBuf,
    pub repository_relative_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalDirectory {
    pub canonical_path: PathBuf,
    pub stable_identity_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalTerminalProcess {
    pub terminal_id: String,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedReadRequest {
    pub authorized_root: PathBuf,
    pub expected_root_identity_json: String,
    pub relative_path: PathBuf,
    pub maximum_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedFileRead {
    pub bytes: Vec<u8>,
    pub source_size: u64,
    pub modified_at_epoch_ms: u64,
    pub source_identity_json: String,
    pub source_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedJsonlListingRequest {
    pub authorized_root: PathBuf,
    pub expected_root_identity_json: String,
    pub maximum_entries: usize,
    pub maximum_directories: usize,
    pub maximum_files: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedJsonlListing {
    pub files: Vec<PathBuf>,
    pub skipped_entry_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedWriteRequest {
    pub path: PathBuf,
    pub authorized_roots: Vec<PathBuf>,
    pub contents: Vec<u8>,
}

#[async_trait]
pub trait ExecutionTarget: Send + Sync {
    fn target_id(&self) -> &str;

    async fn probe(&self) -> Result<TargetHealth, DomainError>;

    async fn canonicalize_path(&self, path: &Path) -> Result<PathBuf, DomainError>;

    async fn authorize_directory(&self, path: &Path) -> Result<CanonicalDirectory, DomainError>;

    async fn authorize_session_directory(
        &self,
        _path: &Path,
    ) -> Result<CanonicalDirectory, DomainError> {
        Err(DomainError::unsupported("authorize_session_directory"))
    }

    async fn resolve_git_identity(&self, _path: &Path) -> Result<Option<GitIdentity>, DomainError> {
        Ok(None)
    }

    async fn run_omp(
        &self,
        executable: &Path,
        expected_identity: &ExecutableIdentityEvidence,
        command: OmpProbeCommand,
    ) -> Result<OmpProcessOutput, DomainError>;

    async fn run_omp_models_json(
        &self,
        _executable: &Path,
        _expected_identity: &ExecutableIdentityEvidence,
        _profile: &str,
        _project: &Path,
    ) -> Result<OmpJsonOutput, DomainError> {
        Err(DomainError::unsupported("run_omp_models_json"))
    }

    async fn spawn_pty(&self) -> Result<PtySpikeReport, DomainError>;

    async fn open_external_terminal(
        &self,
        _plan: &LaunchPlan,
        _expected_identity: &ExecutableIdentityEvidence,
    ) -> Result<ExternalTerminalProcess, DomainError> {
        Err(DomainError::unsupported("open_external_terminal"))
    }

    async fn read_allowed_file(
        &self,
        _request: AllowedReadRequest,
    ) -> Result<AllowedFileRead, DomainError> {
        Err(DomainError::unsupported("read_allowed_file"))
    }

    async fn list_allowed_jsonl_files(
        &self,
        _request: AllowedJsonlListingRequest,
    ) -> Result<AllowedJsonlListing, DomainError> {
        Err(DomainError::unsupported("list_allowed_jsonl_files"))
    }

    async fn atomic_write_allowed_file(
        &self,
        _request: AllowedWriteRequest,
    ) -> Result<(), DomainError> {
        Err(DomainError::unsupported("atomic_write_allowed_file"))
    }

    async fn health_check(&self) -> Result<TargetHealth, DomainError>;
}
