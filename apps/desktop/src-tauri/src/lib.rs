pub mod adapters;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod services;

#[cfg(feature = "desktop")]
pub fn run() {
    use std::sync::Arc;

    use tauri::Manager;

    let context = tauri::generate_context!();
    #[cfg(windows)]
    let _windows_preflight_guard =
        infrastructure::single_instance::acquire_windows_preflight_guard(
            &context.config().identifier,
        )
        .expect("failed to establish Windows single-instance preflight guard");

    tauri::Builder::default()
        // Must remain first: secondary processes exit before any other plugin/setup work.
        .plugin(tauri_plugin_single_instance::init(
            infrastructure::single_instance::handle_forwarded_instance,
        ))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (database_runtime, should_initialize) = match app.path().app_local_data_dir() {
                Ok(app_data_directory) => (
                    infrastructure::db::DatabaseRuntime::pending(app_data_directory),
                    true,
                ),
                Err(_) => (
                    infrastructure::db::DatabaseRuntime::unavailable(domain::DomainError::new(
                        "database_local_data_directory_unavailable",
                        "无法解析 OMP Manager 本地数据目录。",
                        "检查操作系统用户目录配置后重新启动应用。",
                        false,
                        "stage=tauri_setup; local_data_directory=unavailable",
                    )),
                    false,
                ),
            };
            if !app.manage(database_runtime.clone()) {
                return Err(domain::DomainError::new(
                    "database_state_duplicate",
                    "OMP Manager 数据库状态重复初始化。",
                    "重新启动应用；若问题持续，请联系支持人员。",
                    false,
                    "stage=tauri_setup; state=duplicate",
                )
                .into());
            }
            let omp_adapter: Arc<dyn adapters::omp::OmpAdapter> =
                Arc::new(adapters::omp::CliOmpAdapter::default());
            let task_supervisor = services::TaskSupervisor::new(
                database_runtime.clone(),
                omp_adapter.clone(),
                services::TaskPolicy::default(),
            );
            if !app.manage(task_supervisor.clone()) {
                return Err(domain::DomainError::new(
                    "task_supervisor_state_duplicate",
                    "OMP Manager 后台任务状态重复初始化。",
                    "重新启动应用；若问题持续，请联系支持人员。",
                    false,
                    "stage=tauri_setup; task_supervisor=duplicate",
                )
                .into());
            }
            let local_target: Arc<dyn adapters::targets::ExecutionTarget> =
                Arc::new(adapters::targets::LocalTarget::default());
            let project_service =
                services::ProjectService::new(database_runtime.clone(), local_target.clone());
            if !app.manage(project_service.clone()) {
                return Err(domain::DomainError::new(
                    "project_service_state_duplicate",
                    "OMP Manager 项目服务重复初始化。",
                    "重新启动应用；若问题持续，请联系支持人员。",
                    false,
                    "stage=tauri_setup; project_service=duplicate",
                )
                .into());
            }
            let session_service =
                services::SessionService::new(database_runtime.clone(), local_target.clone());
            if !app.manage(session_service.clone()) {
                return Err(domain::DomainError::new(
                    "session_service_state_duplicate",
                    "OMP Manager 会话服务重复初始化。",
                    "重新启动应用；若问题持续，请联系支持人员。",
                    false,
                    "stage=tauri_setup; session_service=duplicate",
                )
                .into());
            }
            let launch_service = services::LaunchService::new(
                project_service,
                session_service,
                task_supervisor.clone(),
                omp_adapter,
                local_target,
                infrastructure::pty::PtyRuntime::default(),
            );
            if !app.manage(launch_service) {
                return Err(domain::DomainError::new(
                    "launch_service_state_duplicate",
                    "OMP Manager 启动服务重复初始化。",
                    "重新启动应用；若问题持续，请联系支持人员。",
                    false,
                    "stage=tauri_setup; launch_service=duplicate",
                )
                .into());
            }
            if should_initialize {
                drop(tauri::async_runtime::spawn(async move {
                    let worker_runtime = database_runtime.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        worker_runtime.run_initialization()
                    })
                    .await;
                    match result {
                        Ok(Ok(report))
                            if report.availability == domain::DatabaseAvailability::Ready =>
                        {
                            let _ = tauri::async_runtime::spawn_blocking(move || {
                                task_supervisor.reconcile_history()
                            })
                            .await;
                        }
                        Ok(Ok(_)) => {}
                        _ => {
                            let _ = database_runtime.mark_initialization_worker_failed();
                        }
                    }
                }));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_project,
            commands::authorize_project_sessions,
            commands::cancel_operation,
            commands::close_pty_run,
            commands::database_status,
            commands::execute_project_launch,
            commands::get_omp_probe_operation,
            commands::list_pty_runs,
            commands::open_project_in_editor,
            commands::prepare_project_launch,
            commands::preview_project_session,
            commands::project_launch_options,
            commands::project_sessions,
            commands::project_workspace,
            commands::pty_spike,
            commands::read_pty_output,
            commands::resize_pty,
            commands::retry_database_initialization,
            commands::scan_project_sessions,
            commands::start_omp_probe,
            commands::terminate_pty,
            commands::update_project_binding,
            commands::write_pty_input
        ])
        .run(context)
        .expect("failed to run OMP Manager");
}
