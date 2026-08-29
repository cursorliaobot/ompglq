use serde::{Deserialize, Serialize};

use super::{Diagnostic, ProbeReport};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    OmpProbe,
}

impl OperationKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OmpProbe => "omp_probe",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Queued,
    Running,
    Cancelling,
    Cancelled,
    Succeeded,
    Failed,
    TimedOut,
    NeedsReconciliation,
}

impl OperationStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
            Self::NeedsReconciliation => "needs_reconciliation",
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Cancelled
                | Self::Succeeded
                | Self::Failed
                | Self::TimedOut
                | Self::NeedsReconciliation
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationSnapshot {
    pub operation_id: String,
    pub kind: OperationKind,
    pub target_id: String,
    pub scope_kind: String,
    pub scope_reference: String,
    pub phase: String,
    pub status: OperationStatus,
    pub revision: u64,
    pub cancellable: bool,
    pub cancellation_requested: bool,
    pub started_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
    pub finished_at_epoch_ms: Option<u64>,
    pub history_persisted: bool,
    pub persistence_diagnostic: Option<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OmpProbeOperationSnapshot {
    pub operation: OperationSnapshot,
    pub result: Option<ProbeReport>,
    pub diagnostic: Option<Diagnostic>,
}

impl OmpProbeOperationSnapshot {
    pub fn is_terminal(&self) -> bool {
        self.operation.status.is_terminal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_status_wire_values_match_the_database_contract() {
        assert_eq!(
            serde_json::to_value(OperationStatus::NeedsReconciliation)
                .expect("serialize operation status"),
            "needs_reconciliation"
        );
        assert!(OperationStatus::TimedOut.is_terminal());
        assert!(!OperationStatus::Running.is_terminal());
    }
}
