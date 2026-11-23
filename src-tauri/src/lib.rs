mod commands;
mod compare;
mod errors;
mod files;
mod hashing;
mod jobs;
mod types;

use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(jobs::Backend::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if window.state::<jobs::Backend>().has_active_job() =>
                {
                    api.prevent_close();
                    let _ = window.emit_to("main", "close-requested", ());
                }
                WindowEvent::Destroyed => {
                    window.state::<jobs::Backend>().close_window(window.label())
                }
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    let backend = window.state::<jobs::Backend>().inner().clone();
                    let app = window.app_handle().clone();
                    if paths.len() != 1 {
                        let _ = app.emit_to(
                            "main",
                            "selection-error",
                            errors::AppError::new(
                                "INVALID_DROP",
                                "Choose one file at a time.",
                                false,
                            ),
                        );
                        return;
                    }
                    let permit = match backend.begin_selection("main") {
                        Ok(permit) => permit,
                        Err(error) => {
                            let _ = app.emit_to("main", "selection-error", error);
                            return;
                        }
                    };
                    let path = paths[0].clone();
                    let _worker =
                        tauri::async_runtime::spawn_blocking(move || {
                            match files::prepare(&path).and_then(|file| permit.commit(file)) {
                                Ok(selection) => {
                                    let _ = app.emit_to("main", "selection-changed", selection);
                                }
                                Err(error) => {
                                    let _ = app.emit_to("main", "selection-error", error);
                                }
                            }
                        });
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::choose_file,
            commands::clear_selection,
            commands::get_selection_details,
            commands::start_hash,
            commands::cancel_hash,
            commands::compare_checksum,
            commands::copy_results,
            commands::platform_info,
            commands::exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = event
                && app.state::<jobs::Backend>().has_active_job()
            {
                api.prevent_exit();
                let _ = app.emit_to("main", "close-requested", ());
            }
        });
}

#[cfg(test)]
mod tests;
