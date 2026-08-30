use std::env;
use std::path::Path;

use omp_manager_lib::adapters::omp::{CliOmpAdapter, OmpAdapter};
use omp_manager_lib::adapters::targets::LocalTarget;
use omp_manager_lib::domain::ProbeStatus;

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if !arguments.is_empty() {
        if is_stub_invocation(&arguments) {
            run_stub(&arguments);
        }
        return;
    }

    let executable = env::current_exe().expect("the integration-test executable path must resolve");
    let runtime = tokio::runtime::Runtime::new().expect("the Tokio runtime must initialize");
    let report = runtime
        .block_on(
            CliOmpAdapter::new(LocalTarget::default())
                .probe_capabilities(Some(Path::new(&executable))),
        )
        .expect("the synthetic OMP probe must complete");

    assert_eq!(report.status, ProbeStatus::Ready);
    assert_eq!(
        report
            .installation
            .as_ref()
            .map(|value| value.version.as_str()),
        Some("18.0.3")
    );
    assert!(report
        .capabilities
        .iter()
        .any(|value| value.id == "profile" && value.available));
    assert!(report
        .capabilities
        .iter()
        .any(|value| value.id == "session_fork" && !value.available));
    assert!(report
        .capabilities
        .iter()
        .any(|value| value.id == "credential_pin" && !value.available));
}

fn is_stub_invocation(arguments: &[String]) -> bool {
    matches!(
        arguments.first().map(String::as_str),
        Some("--version" | "--help")
            | Some("config" | "models" | "usage" | "auth-broker" | "auth-gateway" | "update")
    )
}

fn run_stub(arguments: &[String]) {
    let output = match arguments {
        [flag] if flag == "--version" => "omp/18.0.3\n",
        [flag] if flag == "--help" => {
            "--profile=<value>\n--cwd=<value>\n--resume=<value>\n--export=<value>\n--session-dir=<value>\n"
        }
        [command, flag] if command == "config" && flag == "--help" => "ACTION list|path\n--json\n",
        [command, flag] if command == "models" && flag == "--help" => "ACTION ls\n--json\n--no-extensions\n",
        [command, flag] if command == "usage" && flag == "--help" => "--json\n--redact\n",
        [command, flag] if command == "auth-broker" && flag == "--help" => "ACTION status|list\n--json\n",
        [command, flag] if command == "auth-gateway" && flag == "--help" => "ACTION check\n--json\n--strict\n",
        [command, flag] if command == "update" && flag == "--help" => "--check\n",
        _ => {
            eprintln!("unsupported synthetic command");
            std::process::exit(2);
        }
    };
    print!("{output}");
}
