use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::domain::{DomainError, PtySpikeReport};
use crate::infrastructure::secrets::redact_bytes;

mod runtime;

pub use runtime::{NoopPtyEventSink, PtyEventSink, PtyRuntime};

const MARKER: &str = "OMP_MANAGER_PTY_OK";
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const CHILD_TIMEOUT: Duration = Duration::from_secs(4);

pub fn run_fixed_pty_spike() -> Result<PtySpikeReport, DomainError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| pty_error("pty_open_failed", "无法创建本机 PTY。", error))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| pty_error("pty_reader_failed", "无法读取 PTY 输出。", error))?;
    let command = fixed_marker_command();
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| pty_error("pty_spawn_failed", "无法在 PTY 中启动固定自检程序。", error))?;
    drop(pair.slave);

    pair.master
        .resize(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| pty_error("pty_resize_failed", "PTY resize 自检失败。", error))?;

    let (output_sender, output_receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut retained = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let remaining = MAX_OUTPUT_BYTES.saturating_sub(retained.len());
                    retained.extend_from_slice(&buffer[..count.min(remaining)]);
                }
                Err(error) if is_expected_pty_eof(&error) => break,
                Err(error) => {
                    let _ = output_sender.send(Err(error));
                    return;
                }
            }
        }
        let _ = output_sender.send(Ok(retained));
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < CHILD_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(DomainError::new(
                    "pty_spike_timeout",
                    "PTY 自检程序未在限定时间内结束。",
                    "可重试；若仍失败，请使用外部终端。",
                    true,
                    format!("timeout_ms={}", CHILD_TIMEOUT.as_millis()),
                ));
            }
            Err(error) => {
                return Err(pty_error(
                    "pty_wait_failed",
                    "等待 PTY 自检程序结束时失败。",
                    error,
                ));
            }
        }
    };
    drop(pair.master);

    let output = output_receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|error| pty_error("pty_output_timeout", "读取 PTY 自检结果超时。", error))?
        .map_err(|error| pty_error("pty_output_read_failed", "读取 PTY 自检结果失败。", error))?;
    let output_redacted = redact_bytes(&output);
    let ok = status.success() && output_redacted.contains(MARKER);

    if !ok {
        return Err(DomainError::new(
            "pty_spike_marker_missing",
            "PTY 已启动，但未返回预期自检标记。",
            "可重试；若仍失败，请使用外部终端。",
            true,
            format!("exit_code={} output={output_redacted}", status.exit_code()),
        ));
    }

    Ok(PtySpikeReport {
        ok,
        marker: MARKER.to_owned(),
        exit_code: status.exit_code(),
        resized: true,
        output_redacted,
    })
}

#[cfg(windows)]
fn fixed_marker_command() -> CommandBuilder {
    let mut command = CommandBuilder::new("cmd.exe");
    command.args(["/D", "/Q", "/C", "echo OMP_MANAGER_PTY_OK"]);
    command
}

#[cfg(not(windows))]
fn fixed_marker_command() -> CommandBuilder {
    let executable = if std::path::Path::new("/usr/bin/printf").is_file() {
        "/usr/bin/printf"
    } else {
        "/bin/echo"
    };
    let mut command = CommandBuilder::new(executable);
    command.arg(MARKER);
    command
}

fn pty_error(code: &str, message: &str, error: impl std::fmt::Display) -> DomainError {
    DomainError::new(
        code,
        message,
        "可重试；若仍失败，请使用外部终端。",
        true,
        crate::infrastructure::secrets::redact(&error.to_string()),
    )
}

#[cfg(unix)]
fn is_expected_pty_eof(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(5)
}

#[cfg(not(unix))]
fn is_expected_pty_eof(_error: &std::io::Error) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pty_can_spawn_resize_and_capture_a_marker() {
        let report = run_fixed_pty_spike().expect("the native PTY spike should succeed");
        assert!(report.ok);
        assert!(report.resized);
        assert_eq!(report.exit_code, 0);
        assert!(report.output_redacted.contains(MARKER));
    }
}
