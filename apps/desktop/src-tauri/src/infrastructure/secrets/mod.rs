use std::sync::LazyLock;

use regex::{Captures, Regex};

const REDACTED: &str = "[REDACTED]";
const MAX_UNTRUSTED_TEXT_CHARS: usize = 65_536;

static AUTHORIZATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)([^\s,;]+)")
        .expect("authorization redaction regex must compile")
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})")
        .expect("bearer redaction regex must compile")
});
static COMMON_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?x)
        \b(?:
          sk-[A-Za-z0-9_-]{8,}
          |AIza[0-9A-Za-z_-]{20,}
          |(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}
          |AKIA[0-9A-Z]{16}
        )\b",
    )
    .expect("common key redaction regex must compile")
});
static SENSITIVE_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?im)((?:^|[{\s,])[\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|broker[_-]?token)[\"']?\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,}\]\r\n]+)"#,
    )
    .expect("sensitive field redaction regex must compile")
});
static URL_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)=)[^&#\s]+",
    )
    .expect("URL redaction regex must compile")
});
static COOKIE_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)(\bcookie\s*:\s*)[^\r\n]+").expect("cookie redaction regex must compile")
});

pub fn redact(input: &str) -> String {
    let mut value = sanitize_untrusted_text(input);
    value = AUTHORIZATION
        .replace_all(&value, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures[1])
        })
        .into_owned();
    value = BEARER
        .replace_all(&value, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures[1])
        })
        .into_owned();
    value = SENSITIVE_FIELD
        .replace_all(&value, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures[1])
        })
        .into_owned();
    value = URL_SECRET
        .replace_all(&value, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures[1])
        })
        .into_owned();
    value = COOKIE_HEADER
        .replace_all(&value, |captures: &Captures<'_>| {
            format!("{}{REDACTED}", &captures[1])
        })
        .into_owned();
    COMMON_KEY.replace_all(&value, REDACTED).into_owned()
}

pub fn redact_bytes(input: &[u8]) -> String {
    redact(&String::from_utf8_lossy(input))
}

pub fn sanitize_untrusted_text(input: &str) -> String {
    input
        .chars()
        .take(MAX_UNTRUSTED_TEXT_CHARS)
        .map(|character| match character {
            '\t' | '\n' | '\r' => character,
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => '\u{fffd}',
            value if value.is_control() => '\u{fffd}',
            value => value,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_headers_keys_urls_and_nested_fields() {
        let fake = "sk-SYNTHETIC123456789";
        let input = format!(
            "Authorization: Bearer abc.def.ghi123\nCookie: session=secret\n\
             {{\"nested\":{{\"api_key\":\"{fake}\",\"refresh_token\":\"refresh-value\"}},\
             \"url\":\"https://example.invalid/cb?access_token=url-secret&safe=yes\"}}"
        );
        let output = redact(&input);

        assert!(!output.contains(fake));
        assert!(!output.contains("abc.def.ghi123"));
        assert!(!output.contains("session=secret"));
        assert!(!output.contains("refresh-value"));
        assert!(!output.contains("url-secret"));
        assert!(output.matches(REDACTED).count() >= 5);
        assert!(output.contains("safe=yes"));
    }

    #[test]
    fn preserves_non_secret_lookalikes() {
        let input = "monkey=banana token_count=42 model=provider/model";
        assert_eq!(redact(input), input);
    }

    #[test]
    fn removes_bidi_and_display_control_characters() {
        assert_eq!(sanitize_untrusted_text("ok\u{202e}bad\u{0007}"), "ok�bad�");
    }
}
