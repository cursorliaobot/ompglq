#[cfg(any(feature = "desktop", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForwardedInstanceAction {
    FocusMainWindow,
}

#[cfg(any(windows, test))]
const WINDOWS_RECEIVER_WAIT_ATTEMPTS: u32 = 80;

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsReceiverWaitAction {
    Notify,
    Retry,
    ExitSecondary,
}

#[cfg(any(windows, test))]
fn windows_receiver_wait_action(receiver_found: bool, attempt: u32) -> WindowsReceiverWaitAction {
    if receiver_found {
        WindowsReceiverWaitAction::Notify
    } else if attempt < WINDOWS_RECEIVER_WAIT_ATTEMPTS {
        WindowsReceiverWaitAction::Retry
    } else {
        WindowsReceiverWaitAction::ExitSecondary
    }
}

#[cfg(any(feature = "desktop", test))]
fn classify_forwarded_instance(
    _arguments: &[String],
    _working_directory: &str,
) -> ForwardedInstanceAction {
    ForwardedInstanceAction::FocusMainWindow
}

#[cfg(feature = "desktop")]
pub fn handle_forwarded_instance(
    app: &tauri::AppHandle,
    arguments: Vec<String>,
    working_directory: String,
) {
    use tauri::Manager;

    match classify_forwarded_instance(&arguments, &working_directory) {
        ForwardedInstanceAction::FocusMainWindow => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
}

#[cfg(windows)]
pub struct WindowsPreflightGuard {
    mutex: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for WindowsPreflightGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.mutex);
            windows_sys::Win32::Foundation::CloseHandle(self.mutex);
        }
    }
}

#[cfg(windows)]
pub fn acquire_windows_preflight_guard(
    identifier: &str,
) -> Result<WindowsPreflightGuard, crate::domain::DomainError> {
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_COPYDATA,
    };

    const WMCOPYDATA_SINGLE_INSTANCE_DATA: usize = 1542;
    let mutex_name = encode_windows_wide(format!("{identifier}-preflight-sim"));
    let class_name = encode_windows_wide(format!("{identifier}-sic"));
    let window_name = encode_windows_wide(format!("{identifier}-siw"));
    let mutex = unsafe { CreateMutexW(ptr::null(), true.into(), mutex_name.as_ptr()) };
    if mutex.is_null() {
        return Err(crate::domain::DomainError::new(
            "single_instance_mutex_failed",
            "无法创建 Windows 单实例保护。",
            "重新启动应用；若问题持续，请检查当前用户的桌面会话权限。",
            false,
            "stage=windows_preflight; mutex=create_failed",
        ));
    }

    if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
        return Ok(WindowsPreflightGuard { mutex });
    }

    for attempt in 0..=WINDOWS_RECEIVER_WAIT_ATTEMPTS {
        let receiver = unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
        match windows_receiver_wait_action(!receiver.is_null(), attempt) {
            WindowsReceiverWaitAction::Notify => {
                // The callback intentionally ignores payloads, so forward no args or cwd.
                let payload = b"|\0";
                let copy_data = COPYDATASTRUCT {
                    dwData: WMCOPYDATA_SINGLE_INSTANCE_DATA,
                    cbData: payload.len() as u32,
                    lpData: payload.as_ptr().cast_mut().cast(),
                };
                let mut message_result = 0_usize;
                unsafe {
                    SendMessageTimeoutW(
                        receiver,
                        WM_COPYDATA,
                        0,
                        &copy_data as *const _ as isize,
                        SMTO_ABORTIFHUNG,
                        500,
                        &mut message_result,
                    );
                    CloseHandle(mutex);
                }
                std::process::exit(0);
            }
            WindowsReceiverWaitAction::Retry => {
                thread::sleep(Duration::from_millis(25));
            }
            WindowsReceiverWaitAction::ExitSecondary => {
                unsafe {
                    CloseHandle(mutex);
                }
                std::process::exit(0);
            }
        }
    }
    unreachable!("bounded receiver wait always exits or returns a primary guard")
}

#[cfg(windows)]
fn encode_windows_wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secondary_arguments_can_only_request_focus() {
        let arguments = vec![
            "omp-manager".to_owned(),
            "--project".to_owned(),
            "/tmp/项目;$(touch should-not-run)\nsecret".to_owned(),
        ];
        let action = classify_forwarded_instance(&arguments, "/tmp/untrusted working directory");

        assert_eq!(action, ForwardedInstanceAction::FocusMainWindow);
        assert_eq!(format!("{action:?}"), "FocusMainWindow");
    }

    #[test]
    fn an_empty_forwarded_payload_still_only_focuses() {
        assert_eq!(
            classify_forwarded_instance(&[], ""),
            ForwardedInstanceAction::FocusMainWindow
        );
    }

    #[test]
    fn windows_receiver_wait_is_bounded_and_prefers_notification() {
        assert_eq!(
            windows_receiver_wait_action(true, 0),
            WindowsReceiverWaitAction::Notify
        );
        assert_eq!(
            windows_receiver_wait_action(false, 0),
            WindowsReceiverWaitAction::Retry
        );
        assert_eq!(
            windows_receiver_wait_action(false, WINDOWS_RECEIVER_WAIT_ATTEMPTS),
            WindowsReceiverWaitAction::ExitSecondary
        );
    }
}
