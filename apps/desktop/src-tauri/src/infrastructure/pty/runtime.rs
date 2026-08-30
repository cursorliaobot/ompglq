use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use uuid::Uuid;

use crate::domain::{
    ClosePtyRunRequest, DomainError, ExecutableIdentityEvidence, LaunchPlan, PtyOutputBatch,
    PtyOutputFrame, PtyRunSnapshot, PtyRunStatus, ResizePtyRequest, TerminatePtyRequest,
    WritePtyInputRequest,
};
use crate::infrastructure::process::{
    omp_launch_environment_names, open_verified_executable, OpenedExecutable,
};
use crate::infrastructure::secrets::redact;

const INITIAL_ROWS: u16 = 30;
const INITIAL_COLS: u16 = 120;
const MAXIMUM_INPUT_BYTES: usize = 64 * 1024;
const MAXIMUM_INPUT_QUEUE_MESSAGES: usize = 16;
const MAXIMUM_FRAME_BYTES: usize = 8 * 1024;
const MAXIMUM_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_REPLAY_FRAMES: usize = 4_096;
const MAXIMUM_BATCH_FRAMES: usize = 256;
const MAXIMUM_RUNS: usize = 32;

pub trait PtyEventSink: Send + Sync {
    fn output(&self, frame: &PtyOutputFrame);
    fn status(&self, snapshot: &PtyRunSnapshot);
}

#[derive(Debug, Default)]
pub struct NoopPtyEventSink;

impl PtyEventSink for NoopPtyEventSink {
    fn output(&self, _frame: &PtyOutputFrame) {}

    fn status(&self, _snapshot: &PtyRunSnapshot) {}
}

#[derive(Clone, Default)]
pub struct PtyRuntime {
    inner: Arc<Mutex<RuntimeInner>>,
}

#[derive(Default)]
struct RuntimeInner {
    runs: HashMap<String, RunControl>,
}

#[derive(Clone)]
struct RunControl {
    state: Arc<Mutex<RunState>>,
    _executable: Arc<OpenedExecutable>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    input_sender: Arc<Mutex<Option<SyncSender<Vec<u8>>>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    #[cfg(unix)]
    process_group_leader: Option<libc::pid_t>,
}

struct RunState {
    snapshot: PtyRunSnapshot,
    frames: VecDeque<PtyOutputFrame>,
    replay_bytes: usize,
    reader_finished: bool,
    reader_failed: bool,
}

impl std::fmt::Debug for PtyRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let run_count = self.inner.lock().map(|inner| inner.runs.len()).ok();
        formatter
            .debug_struct("PtyRuntime")
            .field("run_count", &run_count)
            .finish_non_exhaustive()
    }
}

impl PtyRuntime {
    pub fn start_omp(
        &self,
        plan: LaunchPlan,
        expected_executable_identity: ExecutableIdentityEvidence,
        project_id: i64,
        title: String,
        sink: Arc<dyn PtyEventSink>,
    ) -> Result<PtyRunSnapshot, DomainError> {
        if plan.target_id() != "local" {
            return Err(pty_error(
                "pty_target_unavailable",
                "当前内嵌终端仅支持本机 OMP。",
                "选择本机项目后重试。",
                false,
                "target was not local",
            ));
        }
        if plan.terminal_mode() != crate::domain::TerminalMode::Embedded {
            return Err(pty_error(
                "pty_terminal_mode_invalid",
                "启动计划不是内嵌终端模式。",
                "重新生成启动预览。",
                false,
                "terminal mode was not embedded",
            ));
        }
        if plan.temporary_config().is_some() {
            return Err(pty_error(
                "pty_temporary_config_unavailable",
                "当前切片尚未开放临时配置覆盖。",
                "移除无法由命令行表达的角色覆盖后重试。",
                false,
                "temporary config was unexpectedly present",
            ));
        }
        validate_environment_allowlist(plan.env_allowlist())?;

        // Reserve registry capacity before spawning. Holding the registry lock
        // through insertion prevents concurrent starts from creating an
        // untracked child after the active-run limit has been reached.
        let mut inner = self.lock()?;
        prune_runs(&mut inner)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: INITIAL_ROWS,
                cols: INITIAL_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                pty_error(
                    "pty_open_failed",
                    "无法创建 OMP 内嵌终端。",
                    "检查系统 PTY 支持后重试。",
                    true,
                    &redact(&error.to_string()),
                )
            })?;
        let reader = pair.master.try_clone_reader().map_err(|error| {
            pty_error(
                "pty_reader_failed",
                "无法读取 OMP 终端输出。",
                "关闭终端后重新启动。",
                true,
                &redact(&error.to_string()),
            )
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            pty_error(
                "pty_writer_failed",
                "无法连接 OMP 终端输入。",
                "关闭终端后重新启动。",
                true,
                &redact(&error.to_string()),
            )
        })?;
        let opened_executable = Arc::new(open_verified_executable(plan.omp_executable()).map_err(
            |error| {
                pty_error(
                    "pty_executable_identity_unavailable",
                    "无法在启动边界验证 OMP 可执行文件。",
                    "重新检测 OMP 并生成新的启动预览。",
                    true,
                    &redact(&error.to_string()),
                )
            },
        )?);
        if opened_executable.evidence() != &expected_executable_identity {
            return Err(pty_error(
                "pty_executable_changed",
                "OMP 可执行文件在启动前发生变化。",
                "重新检测 OMP 并生成新的启动预览。",
                true,
                "digest-backed identity changed at the PTY spawn boundary",
            ));
        }
        let mut command = CommandBuilder::new(opened_executable.parent_command_path());
        command.args(opened_executable.parent_command_arguments());
        command.args(plan.args());
        command.cwd(plan.cwd());
        command.env_clear();
        for name in plan.env_allowlist() {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(command).map_err(|error| {
            pty_error(
                "pty_spawn_failed",
                "无法在内嵌终端中启动 OMP。",
                "重新检测 OMP 安装和项目权限后重试。",
                true,
                &redact(&error.to_string()),
            )
        })?;
        drop(pair.slave);

        let process_id = child.process_id();
        #[cfg(unix)]
        let process_group_leader = pair
            .master
            .process_group_leader()
            .filter(|leader| process_id == u32::try_from(*leader).ok());
        let killer = child.clone_killer();
        let run_id = Uuid::new_v4().to_string();
        let started_at_epoch_ms = epoch_millis();
        let snapshot = PtyRunSnapshot {
            run_id: run_id.clone(),
            project_id,
            action: plan.action(),
            session_id: plan.session_ref().map(ToOwned::to_owned),
            title,
            profile: plan.profile().to_owned(),
            model_roles: plan.model_roles().clone(),
            thinking_level: plan.thinking_level().map(ToOwned::to_owned),
            status: PtyRunStatus::Running,
            process_id,
            started_at_epoch_ms,
            finished_at_epoch_ms: None,
            exit_code: None,
            signal: None,
            rows: INITIAL_ROWS,
            cols: INITIAL_COLS,
            first_available_sequence: 1,
            last_sequence: 0,
            output_truncated: false,
        };
        let state = Arc::new(Mutex::new(RunState {
            snapshot: snapshot.clone(),
            frames: VecDeque::new(),
            replay_bytes: 0,
            reader_finished: false,
            reader_failed: false,
        }));
        let (input_sender, input_receiver) = sync_channel(MAXIMUM_INPUT_QUEUE_MESSAGES);
        let control = RunControl {
            state: Arc::clone(&state),
            _executable: opened_executable,
            master: Arc::new(Mutex::new(Some(pair.master))),
            input_sender: Arc::new(Mutex::new(Some(input_sender))),
            killer: Arc::new(Mutex::new(killer)),
            #[cfg(unix)]
            process_group_leader,
        };
        inner.runs.insert(run_id.clone(), control.clone());
        drop(inner);

        sink.status(&snapshot);
        spawn_input_writer(writer, input_receiver);
        spawn_output_reader(
            run_id.clone(),
            reader,
            Arc::clone(&state),
            Arc::clone(&sink),
        );
        spawn_child_waiter(child, control, sink);
        Ok(snapshot)
    }

    pub fn list_runs(&self) -> Result<Vec<PtyRunSnapshot>, DomainError> {
        let controls = self
            .lock()?
            .runs
            .values()
            .map(|control| Arc::clone(&control.state))
            .collect::<Vec<_>>();
        let mut snapshots = controls
            .into_iter()
            .map(|state| lock_run_state(&state).map(|state| state.snapshot.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.started_at_epoch_ms));
        Ok(snapshots)
    }

    pub fn read_output(
        &self,
        run_id: &str,
        after_sequence: u64,
    ) -> Result<PtyOutputBatch, DomainError> {
        validate_run_id(run_id)?;
        let state = self.run(run_id)?.state;
        let state = lock_run_state(&state)?;
        let gap_before_first_frame =
            after_sequence.saturating_add(1) < state.snapshot.first_available_sequence;
        let frames = state
            .frames
            .iter()
            .filter(|frame| frame.sequence > after_sequence)
            .take(MAXIMUM_BATCH_FRAMES)
            .cloned()
            .collect();
        Ok(PtyOutputBatch {
            run: state.snapshot.clone(),
            frames,
            gap_before_first_frame,
        })
    }

    pub fn write_input(&self, request: WritePtyInputRequest) -> Result<(), DomainError> {
        validate_run_id(&request.run_id)?;
        if request.bytes.is_empty() || request.bytes.len() > MAXIMUM_INPUT_BYTES {
            return Err(pty_error(
                "pty_input_size_invalid",
                "终端输入大小超过支持范围。",
                "缩短本次输入后重试。",
                false,
                "input was empty or exceeded the bounded write limit",
            ));
        }
        let control = self.run(&request.run_id)?;
        ensure_running(&control.state)?;
        let sender = control.input_sender.lock().map_err(|_| {
            pty_error(
                "pty_input_queue_poisoned",
                "终端输入状态不可用。",
                "关闭终端后重新启动。",
                false,
                "input queue mutex was poisoned",
            )
        })?;
        let sender = sender.as_ref().ok_or_else(|| {
            pty_error(
                "pty_input_closed",
                "OMP 终端输入通道已经关闭。",
                "等待终端完成退出，或启动一个新终端。",
                true,
                "input sender was absent",
            )
        })?;
        sender.try_send(request.bytes).map_err(|error| match error {
            TrySendError::Full(_) => pty_error(
                "pty_input_backpressure",
                "OMP 暂时未能接收更多终端输入。",
                "等待当前输入处理完成后重试。",
                true,
                "bounded input queue was full",
            ),
            TrySendError::Disconnected(_) => pty_error(
                "pty_input_closed",
                "OMP 终端输入通道已经关闭。",
                "等待终端完成退出，或启动一个新终端。",
                true,
                "input writer thread was disconnected",
            ),
        })
    }

    pub fn resize(&self, request: ResizePtyRequest) -> Result<PtyRunSnapshot, DomainError> {
        validate_run_id(&request.run_id)?;
        if !(2..=500).contains(&request.rows)
            || !(2..=500).contains(&request.cols)
            || request.pixel_width > 32_000
            || request.pixel_height > 32_000
        {
            return Err(pty_error(
                "pty_size_invalid",
                "终端尺寸超过支持范围。",
                "调整窗口尺寸后重试。",
                false,
                "rows, columns, or pixels were outside the bounded range",
            ));
        }
        let control = self.run(&request.run_id)?;
        ensure_running(&control.state)?;
        let master = control.master.lock().map_err(|_| {
            pty_error(
                "pty_master_state_poisoned",
                "终端控制状态不可用。",
                "关闭终端后重新启动。",
                false,
                "master mutex was poisoned",
            )
        })?;
        master
            .as_ref()
            .ok_or_else(|| {
                pty_error(
                    "pty_master_closed",
                    "OMP 终端控制通道已经关闭。",
                    "等待终端完成退出。",
                    true,
                    "master PTY was absent",
                )
            })?
            .resize(PtySize {
                rows: request.rows,
                cols: request.cols,
                pixel_width: request.pixel_width,
                pixel_height: request.pixel_height,
            })
            .map_err(|error| {
                pty_error(
                    "pty_resize_failed",
                    "无法调整 OMP 终端尺寸。",
                    "重新调整窗口；若问题持续，请重启该终端。",
                    true,
                    &redact(&error.to_string()),
                )
            })?;
        let mut state = lock_run_state(&control.state)?;
        state.snapshot.rows = request.rows;
        state.snapshot.cols = request.cols;
        Ok(state.snapshot.clone())
    }

    pub fn terminate(&self, request: TerminatePtyRequest) -> Result<PtyRunSnapshot, DomainError> {
        validate_run_id(&request.run_id)?;
        let control = self.run(&request.run_id)?;
        if lock_run_state(&control.state)?.snapshot.status != PtyRunStatus::Running {
            return Ok(lock_run_state(&control.state)?.snapshot.clone());
        }
        if request.force {
            #[cfg(unix)]
            let group_terminated = if let Some(process_group_leader) = control.process_group_leader
            {
                let result = unsafe { libc::kill(-process_group_leader, libc::SIGKILL) };
                if result != 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::ESRCH) {
                        return Err(pty_error(
                            "pty_force_terminate_failed",
                            "无法强制终止 OMP 进程组。",
                            "检查进程状态；不要按 PID 手动终止不确定的进程。",
                            true,
                            &redact(&error.to_string()),
                        ));
                    }
                }
                true
            } else {
                false
            };
            #[cfg(not(unix))]
            let group_terminated = false;
            if !group_terminated {
                control
                    .killer
                    .lock()
                    .map_err(|_| {
                        pty_error(
                            "pty_killer_state_poisoned",
                            "终端终止状态不可用。",
                            "重新启动应用后核对进程状态。",
                            false,
                            "killer mutex was poisoned",
                        )
                    })?
                    .kill()
                    .map_err(|error| {
                        pty_error(
                            "pty_force_terminate_failed",
                            "无法强制终止 OMP 进程。",
                            "检查进程状态；不要按 PID 手动终止不确定的进程。",
                            true,
                            &redact(&error.to_string()),
                        )
                    })?;
            }
            if let Ok(mut sender) = control.input_sender.lock() {
                sender.take();
            }
            if let Ok(mut master) = control.master.lock() {
                master.take();
            }
        } else {
            let sender = control.input_sender.lock().map_err(|_| {
                pty_error(
                    "pty_input_queue_poisoned",
                    "终端输入状态不可用。",
                    "关闭终端后重新启动。",
                    false,
                    "input queue mutex was poisoned",
                )
            })?;
            let sender = sender.as_ref().ok_or_else(|| {
                pty_error(
                    "pty_input_closed",
                    "OMP 终端输入通道已经关闭。",
                    "等待终端完成退出，或选择强制终止。",
                    true,
                    "input sender was absent while interrupting",
                )
            })?;
            sender.try_send(vec![3]).map_err(|error| match error {
                TrySendError::Full(_) => pty_error(
                    "pty_input_backpressure",
                    "OMP 输入队列繁忙，暂时无法发送 Ctrl+C。",
                    "稍后重试，或选择强制终止。",
                    true,
                    "bounded input queue was full while interrupting",
                ),
                TrySendError::Disconnected(_) => pty_error(
                    "pty_input_closed",
                    "OMP 终端输入通道已经关闭。",
                    "等待终端完成退出，或选择强制终止。",
                    true,
                    "input writer disconnected while interrupting",
                ),
            })?;
        }
        let snapshot = lock_run_state(&control.state)?.snapshot.clone();
        Ok(snapshot)
    }

    pub fn close_run(&self, request: ClosePtyRunRequest) -> Result<(), DomainError> {
        validate_run_id(&request.run_id)?;
        let mut inner = self.lock()?;
        let control = inner.runs.get(&request.run_id).ok_or_else(|| {
            pty_error(
                "pty_run_not_found",
                "找不到请求的终端运行记录。",
                "刷新终端列表；若应用已重启，该 PTY 无法重新附着。",
                false,
                "run id was not present in the runtime registry",
            )
        })?;
        let state = lock_run_state(&control.state)?;
        if state.snapshot.status == PtyRunStatus::Running {
            return Err(pty_error(
                "pty_close_running_denied",
                "不能直接关闭仍在运行的 OMP 终端。",
                "先发送 Ctrl+C；必要时确认强制终止，待进程结束后再关闭标签。",
                false,
                "close was requested while the child was running",
            ));
        }
        if !state.reader_finished {
            return Err(pty_error(
                "pty_close_draining",
                "OMP 主进程已结束，但终端输出仍在清理。",
                "稍后重试；若持续不结束，请强制终止该运行。",
                true,
                "terminal status was final before the PTY reader reached EOF",
            ));
        }
        drop(state);
        inner.runs.remove(&request.run_id);
        Ok(())
    }

    fn run(&self, run_id: &str) -> Result<RunControl, DomainError> {
        self.lock()?.runs.get(run_id).cloned().ok_or_else(|| {
            pty_error(
                "pty_run_not_found",
                "找不到请求的终端运行记录。",
                "刷新终端列表；若应用已重启，该 PTY 无法重新附着。",
                false,
                "run id was not present in the runtime registry",
            )
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, RuntimeInner>, DomainError> {
        self.inner.lock().map_err(|_| {
            pty_error(
                "pty_registry_poisoned",
                "终端运行注册表不可用。",
                "重新启动应用后重试。",
                false,
                "runtime registry mutex was poisoned",
            )
        })
    }
}

fn spawn_output_reader(
    run_id: String,
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<RunState>>,
    sink: Arc<dyn PtyEventSink>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; MAXIMUM_FRAME_BYTES];
        let mut reader_failed = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let frame = {
                        let Ok(mut state) = state.lock() else {
                            break;
                        };
                        let sequence = state.snapshot.last_sequence.saturating_add(1);
                        state.snapshot.last_sequence = sequence;
                        let frame = PtyOutputFrame {
                            run_id: run_id.clone(),
                            sequence,
                            bytes: buffer[..count].to_vec(),
                        };
                        state.replay_bytes = state.replay_bytes.saturating_add(count);
                        state.frames.push_back(frame.clone());
                        while state.replay_bytes > MAXIMUM_REPLAY_BYTES
                            || state.frames.len() > MAXIMUM_REPLAY_FRAMES
                        {
                            let Some(discarded) = state.frames.pop_front() else {
                                break;
                            };
                            state.replay_bytes =
                                state.replay_bytes.saturating_sub(discarded.bytes.len());
                            state.snapshot.output_truncated = true;
                        }
                        state.snapshot.first_available_sequence = state
                            .frames
                            .front()
                            .map(|value| value.sequence)
                            .unwrap_or_else(|| state.snapshot.last_sequence.saturating_add(1));
                        frame
                    };
                    sink.output(&frame);
                }
                Err(error) if is_expected_pty_eof(&error) => break,
                Err(_) => {
                    reader_failed = true;
                    break;
                }
            }
        }
        let terminal_snapshot = state.lock().ok().and_then(|mut state| {
            state.reader_finished = true;
            state.reader_failed |= reader_failed;
            if state.snapshot.status == PtyRunStatus::Running {
                None
            } else {
                if state.reader_failed {
                    state.snapshot.status = PtyRunStatus::Failed;
                    state.snapshot.exit_code = None;
                    state.snapshot.signal = None;
                }
                Some(state.snapshot.clone())
            }
        });
        if let Some(snapshot) = terminal_snapshot {
            sink.status(&snapshot);
        }
    });
}

fn spawn_input_writer(
    mut writer: Box<dyn Write + Send>,
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
) {
    std::thread::spawn(move || {
        for bytes in receiver {
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
}

fn spawn_child_waiter(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    control: RunControl,
    sink: Arc<dyn PtyEventSink>,
) {
    std::thread::spawn(move || {
        let result = child.wait();
        if let Ok(mut sender) = control.input_sender.lock() {
            sender.take();
        }
        if let Ok(mut master) = control.master.lock() {
            master.take();
        }
        if !wait_for_reader(&control.state, Duration::from_millis(100)) {
            #[cfg(unix)]
            if let Some(process_group_leader) = control.process_group_leader {
                signal_process_group(process_group_leader, libc::SIGTERM);
            }
        }
        if !wait_for_reader(&control.state, Duration::from_millis(300)) {
            #[cfg(unix)]
            if let Some(process_group_leader) = control.process_group_leader {
                signal_process_group(process_group_leader, libc::SIGKILL);
            }
        }
        let reader_finished = wait_for_reader(&control.state, Duration::from_secs(1));
        let snapshot = {
            let Ok(mut state) = control.state.lock() else {
                return;
            };
            state.snapshot.finished_at_epoch_ms = Some(epoch_millis());
            match result {
                Ok(status) if reader_finished && !state.reader_failed => {
                    state.snapshot.status = PtyRunStatus::Exited;
                    state.snapshot.exit_code = Some(status.exit_code());
                    state.snapshot.signal = status.signal().map(ToOwned::to_owned);
                }
                Ok(_) => {
                    state.snapshot.status = PtyRunStatus::Failed;
                }
                Err(_) => {
                    state.snapshot.status = PtyRunStatus::Failed;
                }
            }
            state.snapshot.clone()
        };
        sink.status(&snapshot);
    });
}

fn wait_for_reader(state: &Arc<Mutex<RunState>>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if state
            .lock()
            .map(|state| state.reader_finished)
            .unwrap_or(false)
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn signal_process_group(process_group_leader: libc::pid_t, signal: libc::c_int) {
    // A still-open reader keeps a failed run non-prunable if this best-effort
    // cleanup cannot reach a descendant that escaped the PTY process group.
    let _ = unsafe { libc::kill(-process_group_leader, signal) };
}

fn ensure_running(state: &Arc<Mutex<RunState>>) -> Result<(), DomainError> {
    if lock_run_state(state)?.snapshot.status != PtyRunStatus::Running {
        return Err(pty_error(
            "pty_run_not_running",
            "该 OMP 终端已经结束。",
            "启动一个新终端。",
            false,
            "run status was terminal",
        ));
    }
    Ok(())
}

fn lock_run_state(state: &Arc<Mutex<RunState>>) -> Result<MutexGuard<'_, RunState>, DomainError> {
    state.lock().map_err(|_| {
        pty_error(
            "pty_run_state_poisoned",
            "终端运行状态不可用。",
            "重新启动应用后核对进程状态。",
            false,
            "run state mutex was poisoned",
        )
    })
}

fn prune_runs(inner: &mut RuntimeInner) -> Result<(), DomainError> {
    if inner.runs.len() < MAXIMUM_RUNS {
        return Ok(());
    }
    let mut terminal = inner
        .runs
        .iter()
        .filter_map(|(run_id, control)| {
            let state = control.state.lock().ok()?;
            (state.snapshot.status != PtyRunStatus::Running && state.reader_finished)
                .then_some((run_id.clone(), state.snapshot.started_at_epoch_ms))
        })
        .collect::<Vec<_>>();
    terminal.sort_by_key(|(_, started_at)| *started_at);
    let remove_count = inner
        .runs
        .len()
        .saturating_add(1)
        .saturating_sub(MAXIMUM_RUNS);
    if terminal.len() < remove_count {
        return Err(pty_error(
            "pty_run_limit_reached",
            "同时保留的 OMP 终端数量已达到上限。",
            "结束并关闭不再使用的终端后重试。",
            true,
            "run registry contained too many active entries",
        ));
    }
    for (run_id, _) in terminal.into_iter().take(remove_count) {
        inner.runs.remove(&run_id);
    }
    Ok(())
}

fn validate_environment_allowlist(names: &[String]) -> Result<(), DomainError> {
    if names.len() > 128 {
        return Err(pty_error(
            "pty_environment_allowlist_too_large",
            "启动环境允许列表超过安全上限。",
            "重新生成启动预览。",
            false,
            "environment allowlist exceeded 128 entries",
        ));
    }
    let allowed = omp_launch_environment_names();
    if names.iter().any(|name| !allowed.contains(&name.as_str())) {
        return Err(pty_error(
            "pty_environment_name_invalid",
            "启动计划包含未允许的环境变量。",
            "重新生成启动预览。",
            false,
            "environment allowlist contained an unknown name",
        ));
    }
    Ok(())
}

fn validate_run_id(run_id: &str) -> Result<(), DomainError> {
    Uuid::parse_str(run_id).map(|_| ()).map_err(|_| {
        pty_error(
            "pty_run_id_invalid",
            "终端运行标识无效。",
            "刷新终端列表后重试。",
            false,
            "run id was not a UUID",
        )
    })
}

fn pty_error(
    code: &str,
    message: &str,
    suggestion: &str,
    retryable: bool,
    technical_detail: &str,
) -> DomainError {
    DomainError::new(
        code,
        message,
        suggestion,
        retryable,
        redact(technical_detail),
    )
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn is_expected_pty_eof(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(5)
}

#[cfg(not(unix))]
fn is_expected_pty_eof(_error: &std::io::Error) -> bool {
    false
}
