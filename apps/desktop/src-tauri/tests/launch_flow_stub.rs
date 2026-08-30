#![cfg_attr(not(target_os = "linux"), allow(dead_code, unused_imports))]

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_manager_lib::adapters::omp::{CliOmpAdapter, OmpAdapter};
use omp_manager_lib::adapters::targets::{
    CanonicalDirectory, ExecutionTarget, ExternalTerminalProcess, LocalTarget, TargetHealth,
};
use omp_manager_lib::domain::{
    AccountPolicy, AddProjectRequest, ClosePtyRunRequest, DomainError, ExecutableIdentityEvidence,
    ExecuteLaunchPlanRequest, LaunchAction, LaunchExecutionResult, LaunchOptionsRequest,
    LaunchPlan, PrepareLaunchPlanRequest, PtyOutputFrame, PtyRunSnapshot, PtySpikeReport,
    ReadPtyOutputRequest, TerminalMode, TerminatePtyRequest, UpdateProjectBindingRequest,
    WritePtyInputRequest,
};
use omp_manager_lib::infrastructure::db::DatabaseRuntime;
use omp_manager_lib::infrastructure::process::{OmpProbeCommand, OmpProcessOutput};
use omp_manager_lib::infrastructure::pty::{NoopPtyEventSink, PtyEventSink, PtyRuntime};
use omp_manager_lib::services::{
    LaunchService, ProjectService, SessionService, TaskPolicy, TaskSupervisor,
};

const MODEL: &str = "synthetic-provider/synthetic-model";
const NEW_MARKER: &str = "OMP_MANAGER_NEW_LAUNCH_OK";
const RESUME_MARKER: &str = "OMP_MANAGER_RESUME_LAUNCH_OK";
const SESSION_ID: &str = "00000000-0000-7000-8000-000000000101";

#[derive(Default)]
struct RecordingSink {
    statuses: Mutex<Vec<PtyRunSnapshot>>,
}

#[derive(Debug, Default)]
struct RecordingExternalTarget {
    local: LocalTarget,
    launch_count: AtomicUsize,
}

#[async_trait::async_trait]
impl ExecutionTarget for RecordingExternalTarget {
    fn target_id(&self) -> &str {
        self.local.target_id()
    }

    async fn probe(&self) -> Result<TargetHealth, DomainError> {
        self.local.probe().await
    }

    async fn canonicalize_path(&self, path: &Path) -> Result<PathBuf, DomainError> {
        self.local.canonicalize_path(path).await
    }

    async fn authorize_directory(&self, path: &Path) -> Result<CanonicalDirectory, DomainError> {
        self.local.authorize_directory(path).await
    }

    async fn run_omp(
        &self,
        executable: &Path,
        expected_identity: &ExecutableIdentityEvidence,
        command: OmpProbeCommand,
    ) -> Result<OmpProcessOutput, DomainError> {
        self.local
            .run_omp(executable, expected_identity, command)
            .await
    }

    async fn spawn_pty(&self) -> Result<PtySpikeReport, DomainError> {
        self.local.spawn_pty().await
    }

    async fn open_external_terminal(
        &self,
        plan: &LaunchPlan,
        expected_identity: &ExecutableIdentityEvidence,
    ) -> Result<ExternalTerminalProcess, DomainError> {
        assert_eq!(plan.terminal_mode(), TerminalMode::External);
        assert_eq!(
            plan.omp_executable(),
            expected_identity.canonical_path.as_path()
        );
        self.launch_count.fetch_add(1, Ordering::SeqCst);
        Ok(ExternalTerminalProcess {
            terminal_id: "synthetic-terminal".to_owned(),
            process_id: Some(4242),
        })
    }

    async fn health_check(&self) -> Result<TargetHealth, DomainError> {
        self.local.health_check().await
    }
}

impl PtyEventSink for RecordingSink {
    fn output(&self, _frame: &PtyOutputFrame) {}

    fn status(&self, snapshot: &PtyRunSnapshot) {
        self.statuses
            .lock()
            .expect("recording sink lock")
            .push(snapshot.clone());
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {}

#[cfg(target_os = "linux")]
fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if !arguments.is_empty() {
        if let Some(arguments) = stub_invocation_arguments(&arguments) {
            run_stub(arguments);
        }
        return;
    }

    let runtime = tokio::runtime::Runtime::new().expect("Tokio runtime");
    runtime.block_on(run_flow());
}

fn stub_invocation_arguments(arguments: &[String]) -> Option<&[String]> {
    if is_stub_invocation(arguments) {
        return Some(arguments);
    }
    let forwarded = arguments.get(1..)?;
    arguments
        .first()
        .is_some_and(|path| std::path::Path::new(path).is_absolute())
        .then_some(forwarded)
        .filter(|arguments| is_stub_invocation(arguments))
}

fn is_stub_invocation(arguments: &[String]) -> bool {
    matches!(
        arguments.first().map(String::as_str),
        Some("--version" | "--help" | "--profile")
            | Some("config" | "models" | "usage" | "auth-broker" | "auth-gateway" | "update")
    )
}

async fn run_flow() {
    use std::os::unix::fs::PermissionsExt;

    env::set_var("ANTHROPIC_API_KEY", "must-not-reach-model-query");
    env::set_var("PI_SMOL_MODEL", "must-not-affect-launch");
    let temporary = tempfile::tempdir().expect("temporary directory");
    let app_data = temporary.path().join("app-data");
    let project_path = temporary.path().join("project");
    std::fs::create_dir_all(&project_path).expect("create project");

    let database = DatabaseRuntime::pending(app_data);
    database
        .run_initialization()
        .expect("initialize launch-flow database");
    let local_target: Arc<dyn ExecutionTarget> = Arc::new(LocalTarget::default());
    let adapter: Arc<dyn OmpAdapter> = Arc::new(CliOmpAdapter::default());
    let supervisor = TaskSupervisor::new(database.clone(), adapter.clone(), TaskPolicy::default());
    let current_executable = env::current_exe().expect("current executable");
    let bun = temporary.path().join("bun");
    std::fs::hard_link(&current_executable, &bun)
        .or_else(|_| std::fs::copy(&current_executable, &bun).map(|_| ()))
        .expect("create synthetic bun interpreter");
    let executable = temporary.path().join("omp");
    std::fs::write(&executable, format!("#!{}\n", bun.display()))
        .expect("create synthetic OMP script");
    for path in [&bun, &executable] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("mark synthetic executable");
    }
    let operation = supervisor
        .start_omp_probe(Some(executable))
        .expect("start synthetic OMP probe");
    let report = loop {
        let snapshot = supervisor
            .get_omp_probe(&operation.operation.operation_id)
            .expect("read synthetic probe");
        if snapshot.is_terminal() {
            break snapshot.result.expect("successful probe report");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(report.installation.is_some());
    assert!(report
        .executable_identity
        .as_ref()
        .and_then(|identity| identity.interpreter.as_ref())
        .is_some());

    let projects = ProjectService::new(database.clone(), local_target.clone());
    let added = projects
        .add_project(
            project_path.clone(),
            AddProjectRequest {
                profile: "default".to_owned(),
                terminal_mode: TerminalMode::Embedded,
                account_policy: AccountPolicy::Automatic,
            },
        )
        .await
        .expect("register project");
    let session_root = temporary.path().join("sessions");
    std::fs::create_dir(&session_root).expect("create session root");
    let session_path = session_root.join("resume.jsonl");
    let session_header = serde_json::json!({
        "type": "session",
        "version": 3,
        "id": SESSION_ID,
        "timestamp": "2026-08-30T00:00:00.000Z",
        "cwd": project_path,
        "title": "Synthetic resumable session"
    });
    let session_message = serde_json::json!({
        "type": "message",
        "id": "message-1",
        "parentId": null,
        "timestamp": "2026-08-30T00:00:01.000Z",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "Synthetic prompt"}]
        }
    });
    std::fs::write(
        &session_path,
        format!("{session_header}\n{session_message}\n"),
    )
    .expect("write synthetic session");
    let sessions = SessionService::new(database, local_target.clone());
    let session_snapshot = sessions
        .authorize_and_scan(added.project.id, session_root)
        .await
        .expect("authorize and index session root");
    let indexed_session = session_snapshot
        .sessions
        .iter()
        .find(|session| session.session_id == SESSION_ID)
        .expect("indexed resumable session");
    let project_updates = projects.clone();
    let external_target = Arc::new(RecordingExternalTarget::default());
    let launches = LaunchService::new(
        projects,
        sessions,
        supervisor,
        adapter,
        external_target.clone(),
        PtyRuntime::default(),
    );
    let scope = LaunchOptionsRequest {
        project_id: added.project.id,
        expected_binding_revision: added.project.binding.revision,
        action: LaunchAction::New,
        session_index_id: None,
    };
    let options = launches
        .options(scope.clone())
        .await
        .expect("load launch options");
    assert!(options
        .available_models
        .iter()
        .any(|model| model.selector == MODEL));

    let unsupported_thinking = launches
        .prepare(PrepareLaunchPlanRequest {
            project_id: scope.project_id,
            expected_binding_revision: scope.expected_binding_revision,
            action: scope.action,
            session_index_id: None,
            model_roles: BTreeMap::from([("default".to_owned(), MODEL.to_owned())]),
            thinking_level: Some("auto".to_owned()),
        })
        .await
        .expect_err("model capability must gate thinking levels");
    assert_eq!(
        unsupported_thinking.code,
        "launch_thinking_model_unsupported"
    );

    let prepared = launches
        .prepare(PrepareLaunchPlanRequest {
            project_id: scope.project_id,
            expected_binding_revision: scope.expected_binding_revision,
            action: scope.action,
            session_index_id: None,
            model_roles: BTreeMap::from([("default".to_owned(), MODEL.to_owned())]),
            thinking_level: Some("medium".to_owned()),
        })
        .await
        .expect("prepare launch");
    assert!(prepared.display_preview_redacted.contains("[project]"));
    assert!(!prepared
        .display_preview_redacted
        .contains(&temporary.path().to_string_lossy().to_string()));

    let recording_sink = Arc::new(RecordingSink::default());
    let new_run = embedded_run(
        launches
            .execute(
                ExecuteLaunchPlanRequest {
                    plan_id: prepared.plan_id.clone(),
                },
                recording_sink.clone(),
            )
            .await
            .expect("execute launch"),
    );
    assert!(recording_sink
        .statuses
        .lock()
        .expect("read recorded statuses")
        .iter()
        .any(|snapshot| {
            snapshot.run_id == new_run.run_id
                && snapshot.status == omp_manager_lib::domain::PtyRunStatus::Running
        }));
    wait_for_run(&launches, &new_run, NEW_MARKER).await;

    let replay = launches
        .execute(
            ExecuteLaunchPlanRequest {
                plan_id: prepared.plan_id,
            },
            Arc::new(NoopPtyEventSink),
        )
        .await
        .expect_err("a launch plan must be single-use");
    assert_eq!(replay.code, "launch_plan_already_used");
    launches
        .close_run(ClosePtyRunRequest {
            run_id: new_run.run_id,
        })
        .expect("close completed new-session run");

    let pressure_plan = launches
        .prepare(PrepareLaunchPlanRequest {
            project_id: scope.project_id,
            expected_binding_revision: scope.expected_binding_revision,
            action: scope.action,
            session_index_id: None,
            model_roles: BTreeMap::from([("default".to_owned(), MODEL.to_owned())]),
            thinking_level: Some("high".to_owned()),
        })
        .await
        .expect("prepare input-pressure launch");
    let pressure_run = embedded_run(
        launches
            .execute(
                ExecuteLaunchPlanRequest {
                    plan_id: pressure_plan.plan_id,
                },
                Arc::new(NoopPtyEventSink),
            )
            .await
            .expect("execute input-pressure launch"),
    );
    let input_started = Instant::now();
    let mut backpressure_seen = false;
    for _ in 0..64 {
        if let Err(error) = launches.write_input(WritePtyInputRequest {
            run_id: pressure_run.run_id.clone(),
            bytes: vec![b'x'; 64 * 1024],
        }) {
            assert_eq!(error.code, "pty_input_backpressure");
            backpressure_seen = true;
            break;
        }
    }
    assert!(
        backpressure_seen,
        "bounded input queue did not apply backpressure"
    );
    assert!(
        input_started.elapsed() < Duration::from_secs(1),
        "input IPC blocked behind the PTY writer"
    );
    launches
        .terminate(TerminatePtyRequest {
            run_id: pressure_run.run_id.clone(),
            force: true,
        })
        .expect("force stop input-pressure run");
    wait_for_terminal(&launches, &pressure_run).await;
    launches
        .close_run(ClosePtyRunRequest {
            run_id: pressure_run.run_id,
        })
        .expect("close input-pressure run");

    let resume_scope = LaunchOptionsRequest {
        project_id: added.project.id,
        expected_binding_revision: added.project.binding.revision,
        action: LaunchAction::Resume,
        session_index_id: Some(indexed_session.session_index_id),
    };
    let resume_options = launches
        .options(resume_scope.clone())
        .await
        .expect("load resume launch options");
    assert_eq!(resume_options.session_id.as_deref(), Some(SESSION_ID));
    let resume_plan = launches
        .prepare(PrepareLaunchPlanRequest {
            project_id: resume_scope.project_id,
            expected_binding_revision: resume_scope.expected_binding_revision,
            action: resume_scope.action,
            session_index_id: resume_scope.session_index_id,
            model_roles: BTreeMap::from([("default".to_owned(), MODEL.to_owned())]),
            thinking_level: None,
        })
        .await
        .expect("prepare resume launch");
    assert_eq!(resume_plan.session_id.as_deref(), Some(SESSION_ID));
    assert!(resume_plan
        .display_preview_redacted
        .contains("[authorized-session]"));
    assert!(!resume_plan
        .display_preview_redacted
        .contains(&session_path.to_string_lossy().to_string()));
    let resume_run = embedded_run(
        launches
            .execute(
                ExecuteLaunchPlanRequest {
                    plan_id: resume_plan.plan_id,
                },
                Arc::new(NoopPtyEventSink),
            )
            .await
            .expect("execute resume launch"),
    );
    wait_for_run(&launches, &resume_run, RESUME_MARKER).await;
    launches
        .close_run(ClosePtyRunRequest {
            run_id: resume_run.run_id,
        })
        .expect("close completed resume run");
    assert!(launches.list_runs().expect("list closed runs").is_empty());

    let external_project = project_updates
        .update_binding(UpdateProjectBindingRequest {
            project_id: added.project.id,
            expected_revision: added.project.binding.revision,
            profile: "default".to_owned(),
            terminal_mode: TerminalMode::External,
            account_policy: AccountPolicy::Automatic,
        })
        .await
        .expect("select external terminal");
    let external_scope = LaunchOptionsRequest {
        project_id: external_project.id,
        expected_binding_revision: external_project.binding.revision,
        action: LaunchAction::New,
        session_index_id: None,
    };
    let external_options = launches
        .options(external_scope.clone())
        .await
        .expect("load external launch options");
    assert_eq!(external_options.terminal_mode, TerminalMode::External);
    assert!(external_options
        .warnings
        .iter()
        .any(|warning| warning == "launch_external_terminal_detached"));
    let external_plan = launches
        .prepare(PrepareLaunchPlanRequest {
            project_id: external_scope.project_id,
            expected_binding_revision: external_scope.expected_binding_revision,
            action: external_scope.action,
            session_index_id: None,
            model_roles: BTreeMap::from([("default".to_owned(), MODEL.to_owned())]),
            thinking_level: None,
        })
        .await
        .expect("prepare external launch");
    assert_eq!(external_plan.terminal_mode, TerminalMode::External);
    assert!(external_plan
        .environment
        .iter()
        .any(|entry| entry.name == "DISPLAY"));
    let external_launch = launches
        .execute(
            ExecuteLaunchPlanRequest {
                plan_id: external_plan.plan_id,
            },
            Arc::new(NoopPtyEventSink),
        )
        .await
        .expect("execute external launch");
    match external_launch {
        LaunchExecutionResult::External { launch } => {
            assert_eq!(launch.terminal_id, "synthetic-terminal");
            assert_eq!(launch.process_id, Some(4242));
            assert_eq!(launch.project_id, added.project.id);
        }
        LaunchExecutionResult::Embedded { .. } => panic!("expected external launch"),
    }
    assert_eq!(external_target.launch_count.load(Ordering::SeqCst), 1);
    assert!(launches
        .list_runs()
        .expect("external launch creates no PTY run")
        .is_empty());

    env::remove_var("ANTHROPIC_API_KEY");
    env::remove_var("PI_SMOL_MODEL");
}

fn embedded_run(result: LaunchExecutionResult) -> PtyRunSnapshot {
    match result {
        LaunchExecutionResult::Embedded { run } => run,
        LaunchExecutionResult::External { .. } => panic!("expected embedded launch"),
    }
}

async fn wait_for_run(launches: &LaunchService, run: &PtyRunSnapshot, marker: &str) {
    let mut output = Vec::new();
    for _ in 0..100 {
        let batch = launches
            .read_output(ReadPtyOutputRequest {
                run_id: run.run_id.clone(),
                after_sequence: 0,
            })
            .expect("read PTY replay");
        output.clear();
        for frame in batch.frames {
            output.extend(frame.bytes);
        }
        if String::from_utf8_lossy(&output).contains(marker)
            && batch.run.status != omp_manager_lib::domain::PtyRunStatus::Running
        {
            assert_eq!(batch.run.exit_code, Some(0));
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "run did not finish with marker {marker}: {}",
        String::from_utf8_lossy(&output)
    );
}

async fn wait_for_terminal(launches: &LaunchService, run: &PtyRunSnapshot) {
    for _ in 0..100 {
        let batch = launches
            .read_output(ReadPtyOutputRequest {
                run_id: run.run_id.clone(),
                after_sequence: 0,
            })
            .expect("read PTY status");
        if batch.run.status != omp_manager_lib::domain::PtyRunStatus::Running {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("run did not reach a terminal state");
}

fn run_stub(arguments: &[String]) {
    if arguments.iter().any(|value| value == "--cwd")
        && (env::var_os("ANTHROPIC_API_KEY").is_some() || env::var_os("PI_SMOL_MODEL").is_some())
    {
        eprintln!("launch inherited an unrelated credential or model override");
        std::process::exit(4);
    }
    let output = match arguments {
        [flag] if flag == "--version" => "omp/18.0.3\n".to_owned(),
        [flag] if flag == "--help" => {
            "--profile=<value>\n--cwd=<value>\n--model=<value>\n--smol=<value>\n--slow=<value>\n--plan=<value>\n--thinking=<value>\n--resume=<value>\n--export=<value>\n--session-dir=<value>\n"
                .to_owned()
        }
        [command, flag] if command == "config" && flag == "--help" => {
            "ACTION list|path\n--json\n".to_owned()
        }
        [command, flag] if command == "models" && flag == "--help" => {
            "ACTION ls\n--json\n--no-extensions\n".to_owned()
        }
        [command, flag] if command == "usage" && flag == "--help" => {
            "--json\n--redact\n".to_owned()
        }
        [command, flag] if command == "auth-broker" && flag == "--help" => {
            "ACTION status|list\n--json\n".to_owned()
        }
        [command, flag] if command == "auth-gateway" && flag == "--help" => {
            "ACTION check\n--json\n--strict\n".to_owned()
        }
        [command, flag] if command == "update" && flag == "--help" => {
            spawn_inherited_background_child();
            "--check\n".to_owned()
        }
        values
            if values
                == [
                    "--profile",
                    "default",
                    "models",
                    "--json",
                    "--no-extensions",
                ] =>
        {
            let isolated_home = env::var("HOME").unwrap_or_default();
            let isolated_cwd = env::current_dir().unwrap_or_default();
            if env::var_os("ANTHROPIC_API_KEY").is_some()
                || env::var_os("PI_SMOL_MODEL").is_some()
                || !isolated_home.contains("omp-manager-models-")
                || !isolated_cwd
                    .to_string_lossy()
                    .contains("omp-manager-models-")
            {
                eprintln!("model query did not use the isolated environment");
                std::process::exit(3);
            }
            format!(
                "{{\"models\":[{{\"provider\":\"synthetic-provider\",\"id\":\"synthetic-model\",\"selector\":\"{MODEL}\",\"name\":\"Synthetic Model\",\"contextWindow\":100000,\"maxTokens\":12000,\"reasoning\":true,\"thinking\":[\"low\",\"medium\",\"high\"],\"input\":[\"text\"]}}]}}\n"
            )
        }
        values
            if values
                .windows(2)
                .any(|pair| pair == ["--thinking", "high"]) =>
        {
            std::thread::sleep(Duration::from_secs(30));
            String::new()
        }
        values if values.iter().any(|value| value == "--resume") => {
            let resume = values
                .iter()
                .position(|value| value == "--resume")
                .and_then(|index| values.get(index + 1))
                .filter(|path| path.ends_with("resume.jsonl"));
            if resume.is_none() {
                eprintln!("resume did not receive the authorized session path: {arguments:?}");
                std::process::exit(2);
            }
            format!("{RESUME_MARKER}\n")
        }
        values if values.iter().any(|value| value == "--cwd") => {
            spawn_inherited_background_child();
            format!("{NEW_MARKER}\n")
        }
        _ => {
            eprintln!("unsupported synthetic command: {arguments:?}");
            std::process::exit(2);
        }
    };
    print!("{output}");
}

#[allow(clippy::zombie_processes)]
fn spawn_inherited_background_child() {
    // Deliberately abandon the direct handle: the parent stub exits while this
    // child keeps inherited PTY/output descriptors open, exercising manager cleanup.
    let _background = std::process::Command::new("sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .expect("spawn inherited background child");
}
