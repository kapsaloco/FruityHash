use crate::errors::{AppError, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Algorithm {
    Md5,
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    pub const ALL: [Self; 4] = [Self::Md5, Self::Sha1, Self::Sha256, Self::Sha512];
    pub fn parse_list(names: &[String]) -> Result<Vec<Self>> {
        if names.is_empty() || names.len() > 16 {
            return Err(AppError::algorithm());
        }
        let mut selected = Vec::new();
        for name in names {
            let algorithm = match name.as_str() {
                "md5" => Self::Md5,
                "sha1" => Self::Sha1,
                "sha256" => Self::Sha256,
                "sha512" => Self::Sha512,
                _ => return Err(AppError::algorithm()),
            };
            if !selected.contains(&algorithm) {
                selected.push(algorithm);
            }
        }
        Ok(Self::ALL
            .into_iter()
            .filter(|a| selected.contains(a))
            .collect())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DigestResult {
    pub algorithm: Algorithm,
    pub hex: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFile {
    pub selection_id: String,
    pub display_name: String,
    pub size_bytes: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionDetails {
    pub path_display: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum HashEvent {
    Started {
        job_id: String,
        sequence: u64,
        total_bytes: String,
    },
    Progress {
        job_id: String,
        sequence: u64,
        processed_bytes: String,
        total_bytes: String,
        elapsed_ms: u64,
    },
    Completed {
        job_id: String,
        sequence: u64,
        processed_bytes: String,
        elapsed_ms: u64,
        results: Vec<DigestResult>,
    },
    Canceled {
        job_id: String,
        sequence: u64,
    },
    Failed {
        job_id: String,
        sequence: u64,
        error: crate::errors::AppError,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelStatus {
    Requested,
    AlreadyFinished,
}
