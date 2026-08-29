use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::ops::Range;

use serde_json::Value;

use super::SessionReadStatus;
use crate::domain::DomainError;
use crate::infrastructure::secrets::sanitize_untrusted_text;

const TITLE_SLOT_BYTES: usize = 256;
const CURRENT_SESSION_VERSION: u64 = 3;
const MAXIMUM_SANITIZED_TEXT_CHARACTERS: usize = 65_536;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionParseLimits {
    pub maximum_file_bytes: usize,
    pub maximum_line_bytes: usize,
    pub maximum_records: usize,
    pub maximum_preview_messages: usize,
    pub maximum_message_characters: usize,
    pub maximum_first_message_characters: usize,
    pub maximum_total_preview_characters: usize,
}

impl Default for SessionParseLimits {
    fn default() -> Self {
        Self {
            maximum_file_bytes: 8 * 1024 * 1024,
            maximum_line_bytes: 1024 * 1024,
            maximum_records: 100_000,
            maximum_preview_messages: 200,
            maximum_message_characters: 16 * 1024,
            maximum_first_message_characters: 512,
            maximum_total_preview_characters: 256 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSessionHeader {
    pub version: Option<u64>,
    pub id: String,
    /// Raw path used only for backend identity matching; never send directly to the WebView.
    pub(crate) cwd: String,
    pub cwd_display: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSessionMessage {
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSession {
    pub header: ParsedSessionHeader,
    pub title: Option<String>,
    pub read_status: SessionReadStatus,
    pub model_selector: Option<String>,
    pub provider: Option<String>,
    pub model_roles: BTreeMap<String, String>,
    pub last_model_role: Option<String>,
    pub thinking_level: Option<String>,
    pub credential_providers: Vec<String>,
    pub message_count: u64,
    pub first_message: Option<String>,
    pub preview_messages: Vec<ParsedSessionMessage>,
    pub skipped_record_count: u64,
    pub warning_codes: Vec<String>,
    pub consumed_bytes: u64,
}

#[derive(Debug)]
struct IndexedEntry {
    id: String,
    parent_id: Option<String>,
    line_range: Range<usize>,
}

#[derive(Debug)]
enum TitleSlot {
    Absent,
    Valid(Option<String>),
    Unverified(Option<String>),
}

#[derive(Debug)]
struct ExtractedText {
    text: String,
    truncated: bool,
}

pub fn parse_session_bytes(
    bytes: &[u8],
    source_truncated: bool,
    limits: &SessionParseLimits,
) -> Result<ParsedSession, DomainError> {
    validate_limits(limits)?;
    if bytes.len() > limits.maximum_file_bytes {
        return Err(parser_error(
            "session_file_too_large",
            "会话文件超过本次只读解析上限。",
            "使用增量扫描或提高受控上限后重试；原文件未被修改。",
            false,
            "stage=session_parse; file=too_large",
        ));
    }

    let complete_bytes = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let has_incomplete_tail = complete_bytes < bytes.len();
    let (title_slot, content_start) = parse_title_slot(bytes);
    let mut warnings = BTreeSet::new();
    let mut partial = source_truncated || has_incomplete_tail;
    if source_truncated {
        warnings.insert("source_truncated".to_owned());
    }
    if has_incomplete_tail {
        warnings.insert("incomplete_tail_ignored".to_owned());
    }
    if matches!(title_slot, TitleSlot::Unverified(_)) {
        partial = true;
        warnings.insert("title_slot_unverified".to_owned());
    }

    let mut header = None;
    let mut header_title = None;
    let mut entries = Vec::new();
    let mut entries_by_id = HashMap::new();
    let mut leaf_id = None;
    let mut skipped_record_count = 0_u64;
    let mut physical_record_count = 0_usize;
    let mut cursor = content_start;

    while cursor < complete_bytes {
        let newline = bytes[cursor..complete_bytes]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| cursor + offset)
            .unwrap_or(complete_bytes);
        let line_range = cursor..newline;
        cursor = newline.saturating_add(1);
        if line_range.is_empty() {
            continue;
        }
        physical_record_count = physical_record_count.saturating_add(1);
        if physical_record_count > limits.maximum_records {
            return Err(parser_error(
                "session_record_limit_exceeded",
                "会话物理记录数量超过本次解析上限。",
                "使用增量扫描或提高受控上限后重试；原文件未被修改。",
                false,
                "stage=session_parse; physical_records=too_many",
            ));
        }
        if line_range.len() > limits.maximum_line_bytes {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("oversized_record_skipped".to_owned());
            continue;
        }
        let Ok(line) = std::str::from_utf8(&bytes[line_range.clone()]) else {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("invalid_utf8_record_skipped".to_owned());
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("malformed_record_skipped".to_owned());
            continue;
        };
        let Some(record) = value.as_object() else {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("non_object_record_skipped".to_owned());
            continue;
        };
        let Some(entry_type) = record.get("type").and_then(Value::as_str) else {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("record_type_missing".to_owned());
            continue;
        };

        if header.is_none() {
            if entry_type != "session" {
                partial = true;
                skipped_record_count = skipped_record_count.saturating_add(1);
                warnings.insert("record_before_header_skipped".to_owned());
                continue;
            }
            let parsed_header = parse_header(record)?;
            if parsed_header
                .version
                .is_some_and(|version| version > CURRENT_SESSION_VERSION)
            {
                partial = true;
                warnings.insert("session_version_unverified".to_owned());
            }
            let (projected_title, title_truncated) =
                projected_display_text(record.get("title"), 2_048);
            header_title = projected_title;
            if title_truncated {
                warnings.insert("header_title_truncated".to_owned());
            }
            header = Some(parsed_header);
            continue;
        }

        if entry_type == "message" && !message_has_minimum_structure(record) {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("message_payload_invalid".to_owned());
            continue;
        }
        let Some(id) = index_text(record.get("id"), 256) else {
            partial = true;
            skipped_record_count = skipped_record_count.saturating_add(1);
            warnings.insert("entry_id_invalid".to_owned());
            continue;
        };
        let parent_id = match record.get("parentId") {
            Some(Value::Null) => None,
            Some(value) => {
                let Some(parent_id) = index_text(Some(value), 256) else {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("entry_parent_invalid".to_owned());
                    continue;
                };
                Some(parent_id)
            }
            None => {
                partial = true;
                skipped_record_count = skipped_record_count.saturating_add(1);
                warnings.insert("entry_parent_missing".to_owned());
                continue;
            }
        };
        let index = entries.len();
        if entries_by_id.insert(id.clone(), index).is_some() {
            partial = true;
            warnings.insert("duplicate_entry_id".to_owned());
        }
        leaf_id = Some(id.clone());
        entries.push(IndexedEntry {
            id,
            parent_id,
            line_range,
        });
    }

    let header = header.ok_or_else(|| {
        parser_error(
            "session_header_missing",
            "会话文件没有完整的逻辑头记录。",
            "文件可能仍在写入或已损坏；稍后重试且不要覆盖原文件。",
            true,
            "stage=session_parse; header=missing",
        )
    })?;
    let branch = active_branch(
        &entries,
        &entries_by_id,
        leaf_id.as_deref(),
        &mut partial,
        &mut warnings,
    );

    let mut branch_title = None;
    let mut model_roles = BTreeMap::new();
    let mut last_model_role = None;
    let mut thinking_level = None;
    let mut credential_providers = BTreeSet::new();
    let mut message_count = 0_u64;
    let mut first_user_message = None;
    let mut fallback_message = None;
    let mut preview_messages = VecDeque::new();
    let mut preview_characters = 0_usize;

    for index in branch {
        let entry = &entries[index];
        let line = std::str::from_utf8(&bytes[entry.line_range.clone()]).map_err(|_| {
            parser_error(
                "session_branch_inconsistent",
                "会话活动分支包含无法再次读取的记录。",
                "保留原文件并重新扫描。",
                true,
                "stage=session_branch; utf8=changed",
            )
        })?;
        let value: Value = serde_json::from_str(line).map_err(|_| {
            parser_error(
                "session_branch_inconsistent",
                "会话活动分支包含无法再次解析的记录。",
                "保留原文件并重新扫描。",
                true,
                "stage=session_branch; json=changed",
            )
        })?;
        let record = value.as_object().ok_or_else(|| {
            parser_error(
                "session_branch_inconsistent",
                "会话活动分支记录结构发生变化。",
                "保留原文件并重新扫描。",
                true,
                "stage=session_branch; object=missing",
            )
        })?;
        let entry_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        match entry_type {
            "message" => {
                let Some(message) = record.get("message").and_then(Value::as_object) else {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("message_payload_invalid".to_owned());
                    continue;
                };
                let (role, role_truncated) = projected_display_text(message.get("role"), 64);
                let Some(role) = role else {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("message_role_invalid".to_owned());
                    continue;
                };
                if role_truncated {
                    partial = true;
                    warnings.insert("message_role_invalid".to_owned());
                    continue;
                }
                message_count = message_count.saturating_add(1);
                if role == "assistant" && !model_roles.contains_key("default") {
                    let (provider, provider_truncated) =
                        projected_display_text(message.get("provider"), 256);
                    let (model, model_truncated) =
                        projected_display_text(message.get("model"), 256);
                    let selector = match (provider, model) {
                        (Some(provider), Some(model))
                            if !provider_truncated && !model_truncated =>
                        {
                            Some(format!("{provider}/{model}"))
                        }
                        _ => None,
                    };
                    if let Some(selector) = selector.filter(|value| is_valid_model_selector(value))
                    {
                        model_roles.insert("default".to_owned(), selector);
                    } else {
                        partial = true;
                        warnings.insert("assistant_model_metadata_invalid".to_owned());
                    }
                    if provider_truncated || model_truncated {
                        warnings.insert("assistant_model_metadata_truncated".to_owned());
                    }
                }
                let Some(extracted) =
                    extract_message_text(message.get("content"), limits.maximum_message_characters)
                else {
                    continue;
                };
                if extracted.truncated {
                    warnings.insert("message_text_truncated".to_owned());
                }

                if first_user_message.is_none() && role == "user" {
                    let (summary, truncated) = truncate_with_flag(
                        &extracted.text,
                        limits.maximum_first_message_characters,
                    );
                    first_user_message = Some(summary);
                    if truncated {
                        warnings.insert("first_message_truncated".to_owned());
                    }
                } else if fallback_message.is_none()
                    && matches!(role.as_str(), "developer" | "assistant")
                {
                    let (summary, truncated) = truncate_with_flag(
                        &extracted.text,
                        limits.maximum_first_message_characters,
                    );
                    fallback_message = Some(summary);
                    if truncated {
                        warnings.insert("first_message_truncated".to_owned());
                    }
                }

                let (timestamp, timestamp_truncated) =
                    projected_display_text(record.get("timestamp"), 128);
                if timestamp_truncated {
                    warnings.insert("message_timestamp_truncated".to_owned());
                }
                push_preview_message(
                    &mut preview_messages,
                    &mut preview_characters,
                    ParsedSessionMessage {
                        role,
                        text: extracted.text,
                        timestamp,
                    },
                    limits,
                    &mut warnings,
                );
            }
            "custom_message" => {
                if record.get("display").and_then(Value::as_bool) == Some(true) {
                    let content = record.get("content");
                    if !append_transcript_preview(
                        record,
                        content,
                        "custom",
                        limits,
                        &mut preview_messages,
                        &mut preview_characters,
                        &mut warnings,
                    ) && !matches!(content, Some(Value::Array(_)))
                    {
                        partial = true;
                        skipped_record_count = skipped_record_count.saturating_add(1);
                        warnings.insert("custom_message_invalid".to_owned());
                    }
                }
            }
            "branch_summary" => {
                if !append_transcript_preview(
                    record,
                    record.get("summary"),
                    "branch_summary",
                    limits,
                    &mut preview_messages,
                    &mut preview_characters,
                    &mut warnings,
                ) {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("branch_summary_invalid".to_owned());
                }
            }
            "compaction" => {
                if !append_transcript_preview(
                    record,
                    record.get("summary"),
                    "compaction",
                    limits,
                    &mut preview_messages,
                    &mut preview_characters,
                    &mut warnings,
                ) {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("compaction_invalid".to_owned());
                }
            }
            "reset_boundary" => {
                warnings.insert("reset_boundary_present".to_owned());
            }
            "model_change" => {
                let (model, model_truncated) = projected_display_text(record.get("model"), 512);
                let Some(model) = model else {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("model_change_invalid".to_owned());
                    continue;
                };
                if model_truncated || !is_valid_model_selector(&model) {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("model_change_invalid".to_owned());
                    continue;
                }
                let (role, role_truncated) = projected_display_text(record.get("role"), 64);
                let role = match (record.get("role"), role, role_truncated) {
                    (None, _, _) => "default".to_owned(),
                    (_, Some(role), false) => role,
                    _ => {
                        partial = true;
                        skipped_record_count = skipped_record_count.saturating_add(1);
                        warnings.insert("model_role_invalid".to_owned());
                        continue;
                    }
                };
                model_roles.insert(role.clone(), model);
                last_model_role = Some(role);
            }
            "thinking_level_change" => {
                let (configured, configured_truncated) =
                    projected_display_text(record.get("configured"), 64);
                let (level, fallback_truncated) = if configured.is_some() || configured_truncated {
                    (configured, configured_truncated)
                } else {
                    projected_display_text(record.get("thinkingLevel"), 64)
                };
                let truncated = configured_truncated || fallback_truncated;
                if truncated {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("thinking_level_invalid".to_owned());
                } else {
                    thinking_level = level;
                }
            }
            "credential_pin" => {
                let (provider, truncated) = projected_display_text(record.get("provider"), 256);
                let hash_valid = record
                    .get("hash")
                    .and_then(Value::as_str)
                    .is_some_and(|hash| {
                        hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
                if let Some(provider) = provider.filter(|_| !truncated && hash_valid) {
                    credential_providers.insert(provider);
                } else {
                    partial = true;
                    skipped_record_count = skipped_record_count.saturating_add(1);
                    warnings.insert("credential_pin_invalid".to_owned());
                }
                // The pseudonymous hash is intentionally never copied into this DTO.
            }
            "title_change" => {
                let (title, truncated) = projected_display_text(record.get("title"), 2_048);
                if truncated {
                    warnings.insert("title_change_truncated".to_owned());
                }
                if let Some(title) = title {
                    branch_title = Some(title);
                }
            }
            "service_tier_change"
            | "custom"
            | "label"
            | "ttsr_injection"
            | "session_init"
            | "mode_change" => {}
            _ => {
                skipped_record_count = skipped_record_count.saturating_add(1);
                warnings.insert("unknown_record_type".to_owned());
            }
        }
    }

    let title = match title_slot {
        TitleSlot::Valid(title) => title,
        TitleSlot::Unverified(Some(title)) => Some(title),
        TitleSlot::Unverified(None) | TitleSlot::Absent => branch_title.or(header_title),
    };
    let first_message = first_user_message.or(fallback_message);
    let model_selector = model_roles.get("default").cloned().or_else(|| {
        last_model_role
            .as_ref()
            .and_then(|role| model_roles.get(role).cloned())
    });
    Ok(ParsedSession {
        header,
        title,
        read_status: if partial {
            SessionReadStatus::Partial
        } else {
            SessionReadStatus::Readable
        },
        provider: model_selector
            .as_deref()
            .and_then(|model| model.split_once('/'))
            .map(|(provider, _)| provider.to_owned()),
        model_selector,
        model_roles,
        last_model_role,
        thinking_level,
        credential_providers: credential_providers.into_iter().collect(),
        message_count,
        first_message,
        preview_messages: preview_messages.into_iter().collect(),
        skipped_record_count,
        warning_codes: warnings.into_iter().collect(),
        consumed_bytes: u64::try_from(complete_bytes).unwrap_or(u64::MAX),
    })
}

fn active_branch(
    entries: &[IndexedEntry],
    entries_by_id: &HashMap<String, usize>,
    leaf_id: Option<&str>,
    partial: &mut bool,
    warnings: &mut BTreeSet<String>,
) -> Vec<usize> {
    let mut branch = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = leaf_id;
    while let Some(id) = cursor {
        if !seen.insert(id.to_owned()) {
            *partial = true;
            warnings.insert("session_branch_cycle".to_owned());
            break;
        }
        let Some(index) = entries_by_id.get(id).copied() else {
            *partial = true;
            warnings.insert("session_branch_parent_missing".to_owned());
            break;
        };
        let entry = &entries[index];
        if entry.id != id {
            *partial = true;
            warnings.insert("session_branch_index_invalid".to_owned());
            break;
        }
        branch.push(index);
        cursor = entry.parent_id.as_deref();
    }
    branch.reverse();
    branch
}

fn parse_title_slot(bytes: &[u8]) -> (TitleSlot, usize) {
    if bytes.len() < TITLE_SLOT_BYTES || bytes[TITLE_SLOT_BYTES - 1] != b'\n' {
        return (TitleSlot::Absent, 0);
    }
    let Ok(line) = std::str::from_utf8(&bytes[..TITLE_SLOT_BYTES - 1]) else {
        return (TitleSlot::Absent, 0);
    };
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return (TitleSlot::Absent, 0);
    };
    let Some(record) = value.as_object() else {
        return (TitleSlot::Absent, 0);
    };
    if record.get("type").and_then(Value::as_str) != Some("title") {
        return (TitleSlot::Absent, 0);
    }
    let (title, title_truncated) = projected_display_text(record.get("title"), 2_048);
    let source_valid = match record.get("source") {
        None => true,
        Some(Value::String(source)) => source == "auto" || source == "user",
        Some(_) => false,
    };
    let valid = record.get("v").and_then(Value::as_u64) == Some(1)
        && record
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|title| !title.contains('\0'))
        && record.get("pad").is_some_and(Value::is_string)
        && record.get("updatedAt").is_some_and(Value::is_string)
        && source_valid
        && !title_truncated;
    if valid {
        (TitleSlot::Valid(title), TITLE_SLOT_BYTES)
    } else {
        (TitleSlot::Unverified(title), TITLE_SLOT_BYTES)
    }
}

fn parse_header(
    record: &serde_json::Map<String, Value>,
) -> Result<ParsedSessionHeader, DomainError> {
    let id = required_text(record.get("id"), "id", 256)?;
    let cwd = required_text(record.get("cwd"), "cwd", 32_768)?;
    let timestamp = required_text(record.get("timestamp"), "timestamp", 128)?;
    if has_unsafe_display_control(&id) || has_unsafe_display_control(&timestamp) {
        return Err(parser_error(
            "session_header_invalid",
            "会话头的技术标识包含不安全显示控制字符。",
            "保留原文件并检查 OMP 会话格式。",
            false,
            "stage=session_header; display_control=present",
        ));
    }
    let version = match record.get("version") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or_else(|| {
            parser_error(
                "session_header_invalid",
                "会话头中的版本字段无效。",
                "保留原文件并检查 OMP 会话格式。",
                false,
                "stage=session_header; field=version",
            )
        })?),
    };
    Ok(ParsedSessionHeader {
        version,
        id,
        cwd_display: sanitize_untrusted_text(&cwd),
        cwd,
        timestamp,
    })
}

fn has_unsafe_display_control(value: &str) -> bool {
    value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            )
    })
}

fn required_text(
    value: Option<&Value>,
    field: &str,
    maximum_characters: usize,
) -> Result<String, DomainError> {
    let value = value.and_then(Value::as_str).ok_or_else(|| {
        parser_error(
            "session_header_invalid",
            "会话头缺少必要文本字段。",
            "保留原文件并检查 OMP 会话格式。",
            false,
            &format!("stage=session_header; field={field}"),
        )
    })?;
    if value.is_empty() || value.contains('\0') || value.chars().count() > maximum_characters {
        return Err(parser_error(
            "session_header_invalid",
            "会话头中的必要文本字段无效或过长。",
            "保留原文件并检查 OMP 会话格式。",
            false,
            &format!("stage=session_header; field={field}; value=invalid"),
        ));
    }
    Ok(value.to_owned())
}

fn index_text(value: Option<&Value>, maximum_characters: usize) -> Option<String> {
    let value = value?.as_str()?;
    if value.is_empty() || value.contains('\0') || value.chars().count() > maximum_characters {
        return None;
    }
    Some(value.to_owned())
}

fn message_has_minimum_structure(record: &serde_json::Map<String, Value>) -> bool {
    let Some(message) = record.get("message").and_then(Value::as_object) else {
        return false;
    };
    let valid_role = message
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| !role.is_empty() && !role.contains('\0') && role.chars().count() <= 64);
    valid_role
        && matches!(
            message.get("content"),
            Some(Value::String(_) | Value::Array(_))
        )
}

fn is_valid_model_selector(value: &str) -> bool {
    value.split_once('/').is_some_and(|(provider, model)| {
        !provider.is_empty()
            && !model.is_empty()
            && !value.contains('\u{fffd}')
            && !provider.chars().any(char::is_whitespace)
            && !model.chars().any(char::is_whitespace)
    })
}

fn projected_display_text(
    value: Option<&Value>,
    maximum_characters: usize,
) -> (Option<String>, bool) {
    let Some(value) = value.and_then(Value::as_str) else {
        return (None, false);
    };
    if value.is_empty() || value.contains('\0') {
        return (None, false);
    }
    let source_characters = value.chars().count();
    let value = sanitize_untrusted_text(value);
    let sanitizer_truncated = value.chars().count() < source_characters;
    let (value, bounded_truncated) = truncate_with_flag(&value, maximum_characters);
    (
        (!value.trim().is_empty()).then_some(value),
        sanitizer_truncated || bounded_truncated,
    )
}

fn push_preview_message(
    messages: &mut VecDeque<ParsedSessionMessage>,
    total_characters: &mut usize,
    mut message: ParsedSessionMessage,
    limits: &SessionParseLimits,
    warnings: &mut BTreeSet<String>,
) {
    let (text, text_truncated) =
        truncate_with_flag(&message.text, limits.maximum_total_preview_characters);
    message.text = text;
    if text_truncated {
        warnings.insert("preview_limit_reached".to_owned());
    }
    let message_characters = message.text.chars().count();
    *total_characters = total_characters.saturating_add(message_characters);
    messages.push_back(message);

    while messages.len() > limits.maximum_preview_messages
        || *total_characters > limits.maximum_total_preview_characters
    {
        let Some(removed) = messages.pop_front() else {
            break;
        };
        *total_characters = total_characters.saturating_sub(removed.text.chars().count());
        warnings.insert("preview_limit_reached".to_owned());
    }
}

fn append_transcript_preview(
    record: &serde_json::Map<String, Value>,
    content: Option<&Value>,
    role: &str,
    limits: &SessionParseLimits,
    messages: &mut VecDeque<ParsedSessionMessage>,
    total_characters: &mut usize,
    warnings: &mut BTreeSet<String>,
) -> bool {
    let Some(extracted) = extract_message_text(content, limits.maximum_message_characters) else {
        return false;
    };
    if extracted.truncated {
        warnings.insert("message_text_truncated".to_owned());
    }
    let (timestamp, timestamp_truncated) = projected_display_text(record.get("timestamp"), 128);
    if timestamp_truncated {
        warnings.insert("message_timestamp_truncated".to_owned());
    }
    push_preview_message(
        messages,
        total_characters,
        ParsedSessionMessage {
            role: role.to_owned(),
            text: extracted.text,
            timestamp,
        },
        limits,
        warnings,
    );
    true
}

fn extract_message_text(value: Option<&Value>, maximum_characters: usize) -> Option<ExtractedText> {
    let mut text = String::new();
    let mut used = 0_usize;
    let mut truncated = false;
    match value? {
        Value::String(value) => {
            truncated |= append_bounded(&mut text, &mut used, value, maximum_characters);
        }
        Value::Array(blocks) => {
            for (index, block) in blocks.iter().enumerate() {
                let Some(block) = block.as_object() else {
                    continue;
                };
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let Some(value) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if !text.is_empty() {
                    if used >= maximum_characters {
                        truncated = true;
                        break;
                    }
                    text.push('\n');
                    used += 1;
                }
                truncated |= append_bounded(&mut text, &mut used, value, maximum_characters);
                if used >= maximum_characters {
                    truncated |= blocks[index + 1..].iter().any(|remaining| {
                        remaining.as_object().is_some_and(|block| {
                            block.get("type").and_then(Value::as_str) == Some("text")
                        })
                    });
                    break;
                }
            }
        }
        _ => return None,
    }
    let text = text.trim().to_owned();
    (!text.is_empty()).then_some(ExtractedText { text, truncated })
}

fn append_bounded(
    target: &mut String,
    used: &mut usize,
    value: &str,
    maximum_characters: usize,
) -> bool {
    let source_characters = value.chars().count();
    let value = sanitize_untrusted_text(value);
    let sanitizer_truncated = value.chars().count() < source_characters;
    let remaining = maximum_characters.saturating_sub(*used);
    let mut characters = value.chars();
    target.extend(characters.by_ref().take(remaining));
    *used = used.saturating_add(remaining.min(value.chars().count()));
    sanitizer_truncated || characters.next().is_some()
}

fn truncate_with_flag(value: &str, maximum_characters: usize) -> (String, bool) {
    let mut characters = value.chars();
    let truncated = characters.by_ref().nth(maximum_characters).is_some();
    (value.chars().take(maximum_characters).collect(), truncated)
}

fn validate_limits(limits: &SessionParseLimits) -> Result<(), DomainError> {
    if limits.maximum_file_bytes == 0
        || limits.maximum_line_bytes == 0
        || limits.maximum_line_bytes > limits.maximum_file_bytes
        || limits.maximum_records == 0
        || limits.maximum_message_characters == 0
        || limits.maximum_message_characters > MAXIMUM_SANITIZED_TEXT_CHARACTERS
        || limits.maximum_first_message_characters == 0
        || limits.maximum_first_message_characters > MAXIMUM_SANITIZED_TEXT_CHARACTERS
        || limits.maximum_total_preview_characters == 0
    {
        return Err(parser_error(
            "session_parse_limits_invalid",
            "会话解析限制配置无效。",
            "恢复默认限制后重试。",
            false,
            "stage=session_parse; limits=invalid",
        ));
    }
    Ok(())
}

fn parser_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    detail: &str,
) -> DomainError {
    DomainError::new(code, message, suggestion, retryable, detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARTIAL_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tests/fixtures/omp/18.0.3/session-v3-partial.jsonl"
    ));

    fn header(title: &str) -> String {
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"session-1\",\
             \"timestamp\":\"2026-08-28T00:00:00.000Z\",\
             \"cwd\":\"/synthetic/project\",\"title\":\"{title}\"}}\n"
        )
    }

    fn entry(entry_type: &str, id: &str, parent_id: Option<&str>, payload: &str) -> String {
        let parent = parent_id.map_or_else(|| "null".to_owned(), |id| format!("\"{id}\""));
        format!(
            "{{\"type\":\"{entry_type}\",\"id\":\"{id}\",\"parentId\":{parent},\
             \"timestamp\":\"2026-08-28T00:00:01Z\"{payload}}}\n"
        )
    }

    fn title_slot(title: &str, version: u64, include_metadata: bool) -> Vec<u8> {
        let metadata = if include_metadata {
            "\"updatedAt\":\"2026-08-28T00:00:01.000Z\","
        } else {
            ""
        };
        let prefix = format!(
            "{{\"type\":\"title\",\"v\":{version},\"title\":\"{title}\",{metadata}\"pad\":\""
        );
        let suffix = "\"}\n";
        let padding = TITLE_SLOT_BYTES - prefix.len() - suffix.len();
        let value = format!("{prefix}{}{suffix}", " ".repeat(padding));
        assert_eq!(value.len(), TITLE_SLOT_BYTES);
        value.into_bytes()
    }

    #[test]
    fn parses_unknown_and_malformed_records_without_exposing_credential_hashes() {
        let parsed = parse_session_bytes(
            PARTIAL_FIXTURE.as_bytes(),
            false,
            &SessionParseLimits::default(),
        )
        .expect("partial session");

        assert_eq!(parsed.header.version, Some(3));
        assert_eq!(parsed.title.as_deref(), Some("Synthetic session"));
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
        assert_eq!(parsed.message_count, 1);
        assert_eq!(parsed.first_message.as_deref(), Some("Synthetic prompt"));
        assert_eq!(parsed.credential_providers, ["synthetic-provider"]);
        assert_eq!(parsed.skipped_record_count, 2);
        assert!(parsed
            .warning_codes
            .contains(&"unknown_record_type".to_owned()));
        assert!(parsed
            .warning_codes
            .contains(&"malformed_record_skipped".to_owned()));
        assert!(!format!("{parsed:?}")
            .contains("0000000000000000000000000000000000000000000000000000000000000000"));
    }

    #[test]
    fn fixed_or_future_title_slots_are_consumed_before_the_header() {
        let mut bytes = title_slot("Current title", 1, true);
        bytes.extend_from_slice(header("Legacy title").as_bytes());
        let parsed = parse_session_bytes(&bytes, false, &SessionParseLimits::default())
            .expect("title slot session");
        assert_eq!(parsed.title.as_deref(), Some("Current title"));
        assert_eq!(parsed.consumed_bytes as usize, bytes.len());
        assert_eq!(parsed.read_status, SessionReadStatus::Readable);

        let mut cleared = title_slot("", 1, true);
        cleared.extend_from_slice(header("Legacy title").as_bytes());
        let parsed = parse_session_bytes(&cleared, false, &SessionParseLimits::default())
            .expect("cleared title slot");
        assert_eq!(parsed.title, None);

        let mut future = title_slot("Future title", 2, false);
        future.extend_from_slice(header("Legacy title").as_bytes());
        let parsed = parse_session_bytes(&future, false, &SessionParseLimits::default())
            .expect("future title slot session");
        assert_eq!(parsed.title.as_deref(), Some("Future title"));
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
        assert!(parsed
            .warning_codes
            .contains(&"title_slot_unverified".to_owned()));

        let prefix = "{\"type\":\"title\",\"v\":1,\"updatedAt\":\"now\",\"pad\":\"";
        let suffix = "\"}\n";
        let mut missing_title = format!(
            "{prefix}{}{suffix}",
            " ".repeat(TITLE_SLOT_BYTES - prefix.len() - suffix.len())
        )
        .into_bytes();
        missing_title.extend_from_slice(header("Header title").as_bytes());
        let parsed = parse_session_bytes(&missing_title, false, &SessionParseLimits::default())
            .expect("missing-title slot consumed");
        assert_eq!(parsed.title.as_deref(), Some("Header title"));
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
    }

    #[test]
    fn projects_only_the_last_physical_leaf_ancestor_chain() {
        let mut session = header("Branches");
        session.push_str(&entry(
            "message",
            "root",
            None,
            ",\"message\":{\"role\":\"user\",\"content\":\"root prompt\"}",
        ));
        session.push_str(&entry(
            "model_change",
            "old-model",
            Some("root"),
            ",\"model\":\"old-provider/old-model\",\"role\":\"default\"",
        ));
        session.push_str(&entry(
            "message",
            "old-message",
            Some("old-model"),
            ",\"message\":{\"role\":\"assistant\",\"content\":\"abandoned branch\"}",
        ));
        session.push_str(&entry(
            "model_change",
            "active-model",
            Some("root"),
            ",\"model\":\"active-provider/main\",\"role\":\"default\"",
        ));
        session.push_str(&entry(
            "model_change",
            "smol-model",
            Some("active-model"),
            ",\"model\":\"active-provider/smol\",\"role\":\"smol\"",
        ));
        session.push_str(&entry(
            "message",
            "active-message",
            Some("smol-model"),
            ",\"message\":{\"role\":\"assistant\",\"content\":\"active branch\"}",
        ));
        let parsed = parse_session_bytes(session.as_bytes(), false, &SessionParseLimits::default())
            .expect("branch session");

        assert_eq!(parsed.message_count, 2);
        assert_eq!(parsed.preview_messages.len(), 2);
        assert!(parsed
            .preview_messages
            .iter()
            .all(|message| message.text != "abandoned branch"));
        assert_eq!(
            parsed.model_selector.as_deref(),
            Some("active-provider/main")
        );
        assert_eq!(
            parsed.model_roles.get("smol").map(String::as_str),
            Some("active-provider/smol")
        );
        assert_eq!(parsed.last_model_role.as_deref(), Some("smol"));
    }

    #[test]
    fn ignores_an_unterminated_appending_tail() {
        let mut bytes = header("Appending").into_bytes();
        bytes.extend_from_slice(
            entry(
                "message",
                "m1",
                None,
                ",\"message\":{\"role\":\"user\",\"content\":\"complete\"}",
            )
            .as_bytes(),
        );
        let consumed = bytes.len();
        bytes.extend_from_slice(b"{\"type\":\"message\",\"message\":{\"role\":\"assistant\"");
        let parsed = parse_session_bytes(&bytes, false, &SessionParseLimits::default())
            .expect("appending session");

        assert_eq!(parsed.message_count, 1);
        assert_eq!(parsed.consumed_bytes as usize, consumed);
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
        assert!(parsed
            .warning_codes
            .contains(&"incomplete_tail_ignored".to_owned()));
    }

    #[test]
    fn keeps_current_transcript_entry_types_and_the_latest_preview_window() {
        let mut session = header("Transcript");
        session.push_str(&entry(
            "custom_message",
            "custom",
            None,
            ",\"customType\":\"notice\",\"display\":true,\"content\":\"custom text\"",
        ));
        session.push_str(&entry(
            "branch_summary",
            "branch",
            Some("custom"),
            ",\"fromId\":\"old\",\"summary\":\"branch summary\"",
        ));
        session.push_str(&entry(
            "compaction",
            "compact",
            Some("branch"),
            ",\"summary\":\"compaction summary\",\"firstKeptEntryId\":\"custom\",\
             \"tokensBefore\":100",
        ));
        session.push_str(&entry("reset_boundary", "reset", Some("compact"), ""));
        for (id, parent, text) in [
            ("m1", "reset", "first"),
            ("m2", "m1", "second"),
            ("m3", "m2", "third"),
        ] {
            session.push_str(&entry(
                "message",
                id,
                Some(parent),
                &format!(",\"message\":{{\"role\":\"assistant\",\"content\":\"{text}\"}}"),
            ));
        }
        let parsed = parse_session_bytes(
            session.as_bytes(),
            false,
            &SessionParseLimits {
                maximum_preview_messages: 5,
                ..SessionParseLimits::default()
            },
        )
        .expect("transcript session");

        assert_eq!(
            parsed
                .preview_messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            [
                "branch summary",
                "compaction summary",
                "first",
                "second",
                "third"
            ]
        );
        assert!(parsed
            .warning_codes
            .contains(&"preview_limit_reached".to_owned()));
        assert!(parsed
            .warning_codes
            .contains(&"reset_boundary_present".to_owned()));
        assert!(!parsed
            .warning_codes
            .contains(&"unknown_record_type".to_owned()));
    }

    #[test]
    fn accepts_image_only_custom_messages_without_copying_binary_content() {
        let mut session = header("Image custom message");
        session.push_str(&entry(
            "custom_message",
            "image",
            None,
            ",\"customType\":\"image\",\"display\":true,\
             \"content\":[{\"type\":\"image\",\"data\":\"base64-not-copied\",\
             \"mimeType\":\"image/png\"}]",
        ));
        let parsed = parse_session_bytes(session.as_bytes(), false, &SessionParseLimits::default())
            .expect("image-only custom message");

        assert_eq!(parsed.read_status, SessionReadStatus::Readable);
        assert_eq!(parsed.skipped_record_count, 0);
        assert!(parsed.preview_messages.is_empty());
        assert!(!format!("{parsed:?}").contains("base64-not-copied"));
    }

    #[test]
    fn enforces_independent_summary_and_total_preview_budgets() {
        let mut session = header("<script>alert(1)</script>");
        session.push_str(&entry(
            "message",
            "m1",
            None,
            ",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\
             \"text\":\"<img src=x>\\u001b[31mabcdefghijklmnop\"}]}",
        ));
        let limits = SessionParseLimits {
            maximum_message_characters: 20,
            maximum_first_message_characters: 6,
            maximum_total_preview_characters: 8,
            ..SessionParseLimits::default()
        };
        let parsed =
            parse_session_bytes(session.as_bytes(), false, &limits).expect("bounded preview");

        assert_eq!(
            parsed
                .first_message
                .as_ref()
                .map(|value| value.chars().count()),
            Some(6)
        );
        assert_eq!(parsed.preview_messages[0].text.chars().count(), 8);
        assert!(parsed.preview_messages[0].text.contains('<'));
        assert!(parsed
            .warning_codes
            .contains(&"message_text_truncated".to_owned()));
        assert!(parsed
            .warning_codes
            .contains(&"first_message_truncated".to_owned()));
        assert!(parsed
            .warning_codes
            .contains(&"preview_limit_reached".to_owned()));
        assert!(parsed
            .title
            .as_deref()
            .is_some_and(|title| title.contains("<script>")));
    }

    #[test]
    fn keeps_role_models_and_all_pin_providers_but_never_hashes() {
        let mut session = header("Metadata");
        session.push_str(&entry(
            "model_change",
            "m",
            None,
            ",\"model\":\"synthetic-provider/model-a\",\"role\":\"default\"",
        ));
        session.push_str(&entry(
            "thinking_level_change",
            "t",
            Some("m"),
            ",\"configured\":\"high\"",
        ));
        session.push_str(&entry(
            "credential_pin",
            "p1",
            Some("t"),
            &format!(
                ",\"provider\":\"provider-a\",\"hash\":\"{}\"",
                "a".repeat(64)
            ),
        ));
        session.push_str(&entry(
            "credential_pin",
            "p2",
            Some("p1"),
            &format!(
                ",\"provider\":\"provider-b\",\"hash\":\"{}\"",
                "b".repeat(64)
            ),
        ));
        session.push_str(&entry(
            "title_change",
            "x",
            Some("p2"),
            ",\"title\":\"Renamed\"",
        ));
        let parsed = parse_session_bytes(session.as_bytes(), false, &SessionParseLimits::default())
            .expect("metadata session");

        assert_eq!(
            parsed.model_selector.as_deref(),
            Some("synthetic-provider/model-a")
        );
        assert_eq!(parsed.thinking_level.as_deref(), Some("high"));
        assert_eq!(parsed.title.as_deref(), Some("Renamed"));
        assert_eq!(parsed.credential_providers, ["provider-a", "provider-b"]);
        assert!(!format!("{parsed:?}").contains(&"a".repeat(64)));
        assert!(!format!("{parsed:?}").contains(&"b".repeat(64)));
    }

    #[test]
    fn rejects_invalid_model_pin_and_oversized_thinking_metadata() {
        let mut session = header("Invalid metadata");
        session.push_str(&entry(
            "model_change",
            "model",
            None,
            ",\"model\":\"missing-provider-separator\",\"role\":\"default\"",
        ));
        session.push_str(&entry(
            "credential_pin",
            "pin",
            Some("model"),
            ",\"provider\":\"provider-a\",\"hash\":\"not-a-sha256\"",
        ));
        session.push_str(&entry(
            "thinking_level_change",
            "thinking",
            Some("pin"),
            &format!(",\"configured\":\"{}\"", "x".repeat(65)),
        ));
        session.push_str(&entry(
            "message",
            "assistant",
            Some("thinking"),
            ",\"message\":{\"role\":\"assistant\",\"provider\":\"bad provider\",\
             \"model\":\"model\",\"content\":\"response\"}",
        ));
        let parsed = parse_session_bytes(session.as_bytes(), false, &SessionParseLimits::default())
            .expect("invalid metadata session");

        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
        assert_eq!(parsed.skipped_record_count, 3);
        assert!(parsed.model_roles.is_empty());
        assert!(parsed
            .warning_codes
            .contains(&"assistant_model_metadata_invalid".to_owned()));
        assert!(parsed.credential_providers.is_empty());
        assert_eq!(parsed.thinking_level, None);
    }

    #[test]
    fn invalid_messages_are_skipped_without_inflating_message_count() {
        let mut session = header("Invalid message");
        session.push_str(&entry("message", "bad", None, ",\"message\":null"));
        let parsed = parse_session_bytes(session.as_bytes(), false, &SessionParseLimits::default())
            .expect("partial message session");

        assert_eq!(parsed.message_count, 0);
        assert_eq!(parsed.skipped_record_count, 1);
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
    }

    #[test]
    fn detects_branch_cycles_and_missing_parents_without_looping() {
        let mut cycle = header("Cycle");
        cycle.push_str(&entry("custom", "cycle", Some("cycle"), ""));
        let parsed = parse_session_bytes(cycle.as_bytes(), false, &SessionParseLimits::default())
            .expect("cycle session");
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
        assert!(parsed
            .warning_codes
            .contains(&"session_branch_cycle".to_owned()));

        let mut missing = header("Missing parent");
        missing.push_str(&entry("custom", "leaf", Some("missing"), ""));
        let parsed = parse_session_bytes(missing.as_bytes(), false, &SessionParseLimits::default())
            .expect("missing-parent session");
        assert!(parsed
            .warning_codes
            .contains(&"session_branch_parent_missing".to_owned()));
    }

    #[test]
    fn bounds_physical_records_and_separates_raw_cwd_from_display_text() {
        let controlled_cwd = "/synthetic/\u{202e}project\nline";
        let session = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"session-1\",\
             \"timestamp\":\"2026-08-28T00:00:00Z\",\
             \"cwd\":\"{}\"}}\n",
            controlled_cwd.replace('\n', "\\n")
        );
        let parsed = parse_session_bytes(session.as_bytes(), false, &SessionParseLimits::default())
            .expect("controlled cwd");
        assert_eq!(parsed.header.cwd, controlled_cwd);
        assert_eq!(parsed.header.cwd_display, "/synthetic/�project\nline");

        let many_lines = format!("{session}{{}}\n{{}}\n");
        let error = parse_session_bytes(
            many_lines.as_bytes(),
            false,
            &SessionParseLimits {
                maximum_records: 2,
                ..SessionParseLimits::default()
            },
        )
        .expect_err("physical record limit");
        assert_eq!(error.code, "session_record_limit_exceeded");
    }

    #[test]
    fn skips_oversized_records_and_rejects_missing_headers() {
        let mut bytes = header("Oversized").into_bytes();
        bytes.extend_from_slice(b"{\"type\":\"custom\",\"payload\":\"");
        bytes.extend(std::iter::repeat_n(b'x', 512));
        bytes.extend_from_slice(b"\"}\n");
        let limits = SessionParseLimits {
            maximum_file_bytes: 1024,
            maximum_line_bytes: 256,
            ..SessionParseLimits::default()
        };
        let parsed = parse_session_bytes(&bytes, false, &limits).expect("oversized record");
        assert_eq!(parsed.read_status, SessionReadStatus::Partial);
        assert!(parsed
            .warning_codes
            .contains(&"oversized_record_skipped".to_owned()));

        let error = parse_session_bytes(
            b"{\"type\":\"message\"}\n",
            false,
            &SessionParseLimits::default(),
        )
        .expect_err("missing header");
        assert_eq!(error.code, "session_header_missing");
    }
}
