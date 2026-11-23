use crate::{
    errors::{AppError, Result},
    hashing::{self, StreamResult},
    types::Algorithm,
};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

#[derive(Debug)]
pub struct PreparedFile {
    pub path: PathBuf,
    pub display_name: String,
    pub size: u64,
}

pub fn prepare(path: &Path) -> Result<PreparedFile> {
    let canonical = fs::canonicalize(path).map_err(AppError::io)?;
    let metadata = fs::metadata(&canonical).map_err(AppError::io)?;
    if !metadata.is_file() {
        return Err(AppError::not_regular());
    }
    Ok(PreparedFile {
        display_name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: canonical,
        size: metadata.len(),
    })
}

fn open_regular(path: &Path) -> Result<File> {
    if !fs::metadata(path).map_err(AppError::io)?.is_file() {
        return Err(AppError::not_regular());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // Avoid blocking on a raced FIFO or following a newly substituted final symlink.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(AppError::io)?;
    if !file.metadata().map_err(AppError::io)?.is_file() {
        return Err(AppError::not_regular());
    }
    Ok(file)
}

fn validate_metadata(before: &Metadata, after: &Metadata, processed: u64) -> Result<()> {
    if processed != before.len()
        || before.len() != after.len()
        || before.modified().map_err(AppError::io)? != after.modified().map_err(AppError::io)?
    {
        return Err(AppError::changed());
    }
    Ok(())
}

pub fn hash_file(
    path: &Path,
    algorithms: &[Algorithm],
    cancel: &AtomicBool,
    mut started: impl FnMut(u64) -> Result<()>,
    progress: impl FnMut(u64, u64) -> Result<()>,
) -> Result<StreamResult> {
    hashing::check_canceled(cancel)?;
    let mut file = open_regular(path)?;
    let before = file.metadata().map_err(AppError::io)?;
    // Require modification timestamps instead of silently skipping change checks.
    before.modified().map_err(AppError::io)?;
    started(before.len())?;
    let mut progress = progress;
    let result = hashing::hash_reader(&mut file, algorithms, before.len(), cancel, |processed| {
        progress(processed, before.len())
    })?;
    let after = file.metadata().map_err(AppError::io)?;
    validate_metadata(&before, &after, result.processed)?;
    // Detect a replaced name on Unix in addition to mutations of the opened handle.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = fs::metadata(path).map_err(|_| AppError::changed())?;
        if before.dev() != current.dev() || before.ino() != current.ino() {
            return Err(AppError::changed());
        }
    }
    hashing::check_canceled(cancel)?;
    Ok(result) // file handle is released before the job commits its terminal state
}
