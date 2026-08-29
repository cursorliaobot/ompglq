use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::Diagnostic;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Error)]
#[error("{code}: {message}")]
pub struct DomainError {
    pub code: String,
    pub message: String,
    pub suggestion: String,
    pub retryable: bool,
    pub technical_detail_redacted: String,
}

impl DomainError {
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

    pub fn unsupported(operation: &str) -> Self {
        Self::new(
            "m0_operation_unavailable",
            "此操作尚未在 M0 安全边界内开放。",
            "请使用当前已开放的 OMP 探测或 PTY 自检功能。",
            false,
            format!("operation={operation}"),
        )
    }
}

impl From<DomainError> for Diagnostic {
    fn from(value: DomainError) -> Self {
        Self {
            code: value.code,
            message: value.message,
            suggestion: value.suggestion,
            retryable: value.retryable,
            technical_detail_redacted: value.technical_detail_redacted,
        }
    }
}
