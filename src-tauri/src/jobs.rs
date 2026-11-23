use crate::{
    compare::{self, Comparison},
    errors::{AppError, Result},
    files::{self, PreparedFile},
    hashing::StreamResult,
    types::{Algorithm, CancelStatus, DigestResult, HashEvent, SelectedFile, SelectionDetails},
};
use std::{
    cell::Cell,
    panic::{AssertUnwindSafe, catch_unwind},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct Backend {
    inner: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    serial: u64,
    selecting: Option<(String, String)>,
    selection: Option<Selection>,
    active: Option<Active>,
    completed: Option<Completed>,
    last_finished: Option<(String, String)>,
    closed: bool,
}
struct Selection {
    owner: String,
    dto: SelectedFile,
    path: PathBuf,
}
struct Active {
    owner: String,
    id: String,
    cancel: Arc<AtomicBool>,
}
struct Completed {
    owner: String,
    id: String,
    results: Vec<DigestResult>,
}

pub struct SelectionPermit {
    backend: Backend,
    owner: String,
    id: String,
}

#[derive(Debug)]
pub struct Admission {
    pub id: String,
    owner: String,
    path: PathBuf,
    algorithms: Vec<Algorithm>,
    cancel: Arc<AtomicBool>,
}

fn owner_allowed(owner: &str) -> Result<()> {
    if owner == "main" {
        Ok(())
    } else {
        Err(AppError::new(
            "INVALID_WINDOW",
            "This operation is available only in the main window.",
            false,
        ))
    }
}
impl Registry {
    fn next_id(&mut self, kind: &str) -> Result<String> {
        self.serial = self.serial.checked_add(1).ok_or_else(AppError::internal)?;
        Ok(format!("{kind}-{}", self.serial))
    }
    fn idle(&self) -> Result<()> {
        if self.closed {
            return Err(AppError::selection());
        }
        if self.active.is_some() || self.selecting.is_some() {
            return Err(AppError::busy());
        }
        Ok(())
    }
}
impl Backend {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        // No IO, callbacks or worker code runs under this mutex. Recover it so
        // unwinding cannot permanently strand the cancellation registry.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub fn begin_selection(&self, owner: &str) -> Result<SelectionPermit> {
        owner_allowed(owner)?;
        let mut registry = self.lock();
        registry.idle()?;
        let id = registry.next_id("selection")?;
        registry.selecting = Some((owner.to_owned(), id.clone()));
        Ok(SelectionPermit {
            backend: self.clone(),
            owner: owner.to_owned(),
            id,
        })
    }
    pub fn clear_selection(&self, owner: &str, id: &str) -> Result<()> {
        owner_allowed(owner)?;
        let mut registry = self.lock();
        registry.idle()?;
        registry
            .selection
            .as_ref()
            .filter(|s| s.owner == owner && s.dto.selection_id == id)
            .ok_or_else(AppError::selection)?;
        registry.selection = None;
        registry.completed = None;
        registry.last_finished = None;
        Ok(())
    }
    pub fn details(&self, owner: &str, id: &str) -> Result<SelectionDetails> {
        owner_allowed(owner)?;
        let registry = self.lock();
        let selection = registry
            .selection
            .as_ref()
            .filter(|s| s.owner == owner && s.dto.selection_id == id)
            .ok_or_else(AppError::selection)?;
        Ok(SelectionDetails {
            path_display: selection.path.to_string_lossy().into_owned(),
        })
    }
    pub fn admit(&self, owner: &str, selection_id: &str, names: &[String]) -> Result<Admission> {
        owner_allowed(owner)?;
        let algorithms = Algorithm::parse_list(names)?;
        let mut registry = self.lock();
        registry.idle()?;
        let path = registry
            .selection
            .as_ref()
            .filter(|s| s.owner == owner && s.dto.selection_id == selection_id)
            .ok_or_else(AppError::selection)?
            .path
            .clone();
        let id = registry.next_id("job")?;
        let cancel = Arc::new(AtomicBool::new(false));
        registry.active = Some(Active {
            owner: owner.to_owned(),
            id: id.clone(),
            cancel: cancel.clone(),
        });
        registry.completed = None;
        registry.last_finished = None;
        Ok(Admission {
            id,
            owner: owner.to_owned(),
            path,
            algorithms,
            cancel,
        })
    }
    pub fn cancel(&self, owner: &str, id: &str) -> Result<CancelStatus> {
        owner_allowed(owner)?;
        let registry = self.lock();
        if let Some(active) = &registry.active
            && active.owner == owner
            && active.id == id
        {
            // Serialized with completion commit; accepted cancellation wins.
            active.cancel.store(true, Ordering::Release);
            return Ok(CancelStatus::Requested);
        }
        if registry
            .last_finished
            .as_ref()
            .is_some_and(|(o, job)| o == owner && job == id)
        {
            return Ok(CancelStatus::AlreadyFinished);
        }
        Err(AppError::job())
    }
    pub fn compare(&self, owner: &str, id: &str, expected: &str) -> Result<Comparison> {
        owner_allowed(owner)?;
        let registry = self.lock();
        let completed = registry
            .completed
            .as_ref()
            .filter(|s| s.owner == owner && s.id == id)
            .ok_or_else(AppError::job)?;
        Ok(compare::compare(&completed.results, expected))
    }
    pub fn has_active_job(&self) -> bool {
        self.lock().active.is_some()
    }

    pub fn clipboard_text(
        &self,
        owner: &str,
        id: &str,
        algorithm: Option<Algorithm>,
    ) -> Result<String> {
        owner_allowed(owner)?;
        let registry = self.lock();
        let completed = registry
            .completed
            .as_ref()
            .filter(|job| job.owner == owner && job.id == id)
            .ok_or_else(AppError::job)?;
        if let Some(algorithm) = algorithm {
            return completed
                .results
                .iter()
                .find(|result| result.algorithm == algorithm)
                .map(|result| result.hex.clone())
                .ok_or_else(AppError::algorithm);
        }
        Ok(completed
            .results
            .iter()
            .map(|result| {
                let label = match result.algorithm {
                    Algorithm::Md5 => "MD5",
                    Algorithm::Sha1 => "SHA-1",
                    Algorithm::Sha256 => "SHA-256",
                    Algorithm::Sha512 => "SHA-512",
                };
                format!("{label}: {}", result.hex)
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    pub fn close_window(&self, owner: &str) {
        if owner != "main" {
            return;
        }
        let mut registry = self.lock();
        registry.closed = true;
        registry.selecting = None;
        registry.selection = None;
        registry.completed = None;
        registry.last_finished = None;
        if let Some(active) = &registry.active {
            active.cancel.store(true, Ordering::Release);
        }
    }
    fn finish(
        &self,
        admission: &Admission,
        result: Result<StreamResult>,
        elapsed_ms: u64,
        sequence: u64,
    ) -> HashEvent {
        let mut registry = self.lock();
        let job_id = admission.id.clone();
        // The worker has dropped its file before entering this critical section.
        let canceled = admission.cancel.load(Ordering::Acquire) || registry.closed;
        let event = if canceled {
            HashEvent::Canceled { job_id, sequence }
        } else {
            match result {
                Ok(result) => {
                    registry.completed = Some(Completed {
                        owner: admission.owner.clone(),
                        id: admission.id.clone(),
                        results: result.results.clone(),
                    });
                    HashEvent::Completed {
                        job_id,
                        sequence,
                        processed_bytes: result.processed.to_string(),
                        elapsed_ms,
                        results: result.results,
                    }
                }
                Err(error) if error.code == "CANCELED" => HashEvent::Canceled { job_id, sequence },
                Err(error) => HashEvent::Failed {
                    job_id,
                    sequence,
                    error,
                },
            }
        };
        registry.active = None;
        if !registry.closed {
            registry.last_finished = Some((admission.owner.clone(), admission.id.clone()));
        }
        event
    }
    pub fn run_job(&self, admission: Admission, sink: impl Fn(HashEvent) -> bool) {
        let began = Instant::now();
        let sequence = Cell::new(0u64);
        let next = || {
            let value = sequence.get() + 1;
            sequence.set(value);
            value
        };
        let emit = |event| {
            if sink(event) {
                Ok(())
            } else {
                admission.cancel.store(true, Ordering::Release);
                Err(AppError::canceled())
            }
        };
        let last_progress = Cell::new(Instant::now());
        let result = catch_unwind(AssertUnwindSafe(|| {
            files::hash_file(
                &admission.path,
                &admission.algorithms,
                &admission.cancel,
                |total| {
                    emit(HashEvent::Started {
                        job_id: admission.id.clone(),
                        sequence: next(),
                        total_bytes: total.to_string(),
                    })
                },
                |processed, total| {
                    let now = Instant::now();
                    if now.duration_since(last_progress.get()) >= Duration::from_millis(100) {
                        last_progress.set(now);
                        emit(HashEvent::Progress {
                            job_id: admission.id.clone(),
                            sequence: next(),
                            processed_bytes: processed.to_string(),
                            total_bytes: total.to_string(),
                            elapsed_ms: millis(began),
                        })?;
                    }
                    Ok(())
                },
            )
        }))
        .unwrap_or_else(|_| Err(AppError::internal()));
        let terminal = self.finish(&admission, result, millis(began), next());
        // Cleanup is already committed even if the IPC endpoint vanished/panicked.
        let _ = catch_unwind(AssertUnwindSafe(|| sink(terminal)));
    }
}
fn millis(began: Instant) -> u64 {
    began.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

impl SelectionPermit {
    pub fn commit(self, prepared: PreparedFile) -> Result<SelectedFile> {
        let mut registry = self.backend.lock();
        if registry.closed
            || registry.selecting.as_ref() != Some(&(self.owner.clone(), self.id.clone()))
        {
            return Err(AppError::selection());
        }
        let dto = SelectedFile {
            selection_id: self.id.clone(),
            display_name: prepared.display_name,
            size_bytes: prepared.size.to_string(),
        };
        registry.selection = Some(Selection {
            owner: self.owner.clone(),
            dto: dto.clone(),
            path: prepared.path,
        });
        registry.completed = None;
        registry.last_finished = None;
        registry.selecting = None;
        Ok(dto)
    }
}
impl Drop for SelectionPermit {
    fn drop(&mut self) {
        let mut registry = self.backend.lock();
        if registry.selecting.as_ref() == Some(&(self.owner.clone(), self.id.clone())) {
            registry.selecting = None;
        }
    }
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
