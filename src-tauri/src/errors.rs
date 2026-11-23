use serde::Serialize;
use std::{fmt, io};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl AppError {
    pub const fn new(code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message,
            retryable,
        }
    }
    pub fn internal() -> Self {
        Self::new("INTERNAL", "Calculation could not finish. Try again.", true)
    }
    pub fn busy() -> Self {
        Self::new(
            "BUSY",
            "A calculation or file selection is already running.",
            true,
        )
    }
    pub fn selection() -> Self {
        Self::new(
            "INVALID_SELECTION",
            "Choose the file again before calculating.",
            true,
        )
    }
    pub fn job() -> Self {
        Self::new(
            "INVALID_JOB",
            "Calculate the file again before using this result.",
            true,
        )
    }
    pub fn algorithm() -> Self {
        Self::new(
            "INVALID_ALGORITHM",
            "Select at least one supported algorithm.",
            false,
        )
    }
    pub fn canceled() -> Self {
        Self::new(
            "CANCELED",
            "Calculation canceled. No results were kept.",
            true,
        )
    }
    pub fn changed() -> Self {
        Self::new(
            "FILE_CHANGED",
            "The file changed during calculation. Try again with a stable copy.",
            true,
        )
    }
    pub fn not_regular() -> Self {
        Self::new(
            "NOT_REGULAR_FILE",
            "Choose a regular file; folders and devices are not supported.",
            false,
        )
    }
    pub fn io(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::new(
                "NOT_FOUND",
                "The file is no longer available. Choose it again.",
                true,
            ),
            io::ErrorKind::PermissionDenied => Self::new(
                "PERMISSION_DENIED",
                "FruityHash cannot read this file. Choose a readable copy.",
                true,
            ),
            _ => Self::new(
                "READ_FAILED",
                "The file could not be read completely. Check the drive and try again.",
                true,
            ),
        }
    }
}
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for AppError {}
pub type Result<T> = std::result::Result<T, AppError>;
