use crate::{
    compare::Comparison,
    errors::{AppError, Result},
    files,
    jobs::Backend,
    types::{CancelStatus, HashEvent, SelectedFile, SelectionDetails},
};
use tauri::{State, WebviewWindow, ipc::Channel};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn choose_file(
    window: WebviewWindow,
    backend: State<'_, Backend>,
) -> Result<Option<SelectedFile>> {
    let permit = backend.begin_selection(window.label())?;
    // The Rust-side picker keeps the full path out of frontend arguments.
    tauri::async_runtime::spawn_blocking(move || {
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Choose a file to hash")
            .blocking_pick_file();
        match picked {
            None => Ok(None), // dropping the permit restores the previous selection
            Some(path) => {
                let path = path.into_path().map_err(|_| AppError::not_regular())?;
                permit.commit(files::prepare(&path)?).map(Some)
            }
        }
    })
    .await
    .map_err(|_| AppError::internal())?
}

#[tauri::command]
pub fn clear_selection(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    selection_id: String,
) -> Result<()> {
    backend.clear_selection(window.label(), &selection_id)
}
#[tauri::command]
pub fn get_selection_details(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    selection_id: String,
) -> Result<SelectionDetails> {
    backend.details(window.label(), &selection_id)
}
#[tauri::command]
pub fn start_hash(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    selection_id: String,
    algorithms: Vec<String>,
    on_event: Channel<HashEvent>,
) -> Result<String> {
    let admission = backend.admit(window.label(), &selection_id, &algorithms)?;
    let id = admission.id.clone();
    let backend = backend.inner().clone();
    let _worker = tauri::async_runtime::spawn_blocking(move || {
        backend.run_job(admission, |event| on_event.send(event).is_ok());
    });
    Ok(id)
}
#[tauri::command]
pub fn cancel_hash(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    job_id: String,
) -> Result<CancelStatus> {
    backend.cancel(window.label(), &job_id)
}
#[tauri::command]
pub fn compare_checksum(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    job_id: String,
    expected: String,
) -> Result<Comparison> {
    backend.compare(window.label(), &job_id, &expected)
}

#[tauri::command]
pub fn platform_info() -> serde_json::Value {
    serde_json::json!({ "platform": if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "windows") { "windows" } else { "other" }, "version": env!("CARGO_PKG_VERSION") })
}

#[tauri::command]
pub fn copy_results(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    job_id: String,
    algorithm: Option<crate::types::Algorithm>,
) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = backend.clipboard_text(window.label(), &job_id, algorithm)?;
    window.clipboard().write_text(text).map_err(|_| {
        AppError::new(
            "CLIPBOARD_FAILED",
            "Could not copy. Select the checksum and copy it manually.",
            true,
        )
    })
}

#[tauri::command]
pub fn exit_app(window: WebviewWindow, backend: State<'_, Backend>, force: bool) -> Result<()> {
    use tauri::Manager;
    if window.label() != "main" {
        return Err(AppError::selection());
    }
    if backend.has_active_job() && !force {
        return Err(AppError::busy());
    }
    backend.close_window("main");
    window.app_handle().exit(0);
    Ok(())
}
