use super::*;
use crate::{compare::Verdict, tests::Fixture};
use std::{cell::RefCell, fs};

fn ready(bytes: &[u8]) -> (Fixture, Backend, String) {
    let fixture = Fixture::new(bytes);
    let backend = Backend::default();
    let selection = backend
        .begin_selection("main")
        .unwrap()
        .commit(files::prepare(&fixture.path).unwrap())
        .unwrap();
    (fixture, backend, selection.selection_id)
}
fn admit(backend: &Backend, selection: &str) -> Admission {
    backend
        .admit("main", selection, &["sha256".into()])
        .unwrap()
}
fn run(backend: &Backend, admission: Admission) -> Vec<HashEvent> {
    let events = RefCell::new(Vec::new());
    backend.run_job(admission, |event| {
        events.borrow_mut().push(event);
        true
    });
    events.into_inner()
}
fn terminal_count(events: &[HashEvent]) -> usize {
    events
        .iter()
        .filter(|e| {
            matches!(
                e,
                HashEvent::Completed { .. } | HashEvent::Canceled { .. } | HashEvent::Failed { .. }
            )
        })
        .count()
}
#[test]
fn complete_job_compare_and_cancel_after_commit() {
    let (_fixture, backend, selection) = ready(b"abc");
    let admission = admit(&backend, &selection);
    let id = admission.id.clone();
    let events = run(&backend, admission);
    assert_eq!(terminal_count(&events), 1);
    assert!(matches!(&events[0], HashEvent::Started { total_bytes, .. } if total_bytes == "3"));
    let HashEvent::Completed { results, .. } = events.last().unwrap() else {
        panic!("expected completion")
    };
    assert_eq!(
        backend
            .compare("main", &id, &results[0].hex)
            .unwrap()
            .verdict,
        Verdict::Match
    );
    assert_eq!(
        backend.cancel("main", &id).unwrap(),
        CancelStatus::AlreadyFinished
    );
    assert!(backend.lock().active.is_none());
}
#[test]
fn active_job_blocks_start_replacement_and_clear() {
    let (fixture, backend, selection) = ready(b"abc");
    let admission = admit(&backend, &selection);
    assert_eq!(
        backend
            .admit("main", &selection, &["sha256".into()])
            .unwrap_err()
            .code,
        "BUSY"
    );
    assert_eq!(backend.begin_selection("main").err().unwrap().code, "BUSY");
    assert_eq!(
        backend
            .clear_selection("main", &selection)
            .unwrap_err()
            .code,
        "BUSY"
    );
    assert_eq!(
        backend.cancel("main", &admission.id).unwrap(),
        CancelStatus::Requested
    );
    assert_eq!(
        backend.cancel("main", &admission.id).unwrap(),
        CancelStatus::Requested
    );
    let events = run(&backend, admission);
    assert!(matches!(events.last(), Some(HashEvent::Canceled { .. })));
    assert_eq!(terminal_count(&events), 1);
    let events = run(&backend, admit(&backend, &selection));
    assert!(matches!(events.last(), Some(HashEvent::Completed { .. })));
    assert!(fixture.path.exists());
}
#[test]
fn accepted_cancellation_wins_over_ready_results() {
    let (_fixture, backend, selection) = ready(b"abc");
    let admission = admit(&backend, &selection);
    backend.cancel("main", &admission.id).unwrap();
    let result = Ok(StreamResult {
        processed: 3,
        results: vec![DigestResult {
            algorithm: Algorithm::Sha256,
            hex: "unused".into(),
        }],
    });
    assert!(matches!(
        backend.finish(&admission, result, 1, 1),
        HashEvent::Canceled { .. }
    ));
    assert!(backend.lock().completed.is_none());
}
#[test]
fn cancellation_from_started_event_does_not_deadlock() {
    let (_fixture, backend, selection) = ready(b"abc");
    let admission = admit(&backend, &selection);
    let id = admission.id.clone();
    let events = RefCell::new(Vec::new());
    backend.run_job(admission, |event| {
        if matches!(event, HashEvent::Started { .. }) {
            backend.cancel("main", &id).unwrap();
        }
        events.borrow_mut().push(event);
        true
    });
    let events = events.into_inner();
    assert!(matches!(events.last(), Some(HashEvent::Canceled { .. })));
    assert_eq!(terminal_count(&events), 1);
}
#[test]
fn disconnected_channel_cancels_and_releases_admission() {
    let (_fixture, backend, selection) = ready(b"abc");
    let events = RefCell::new(Vec::new());
    backend.run_job(admit(&backend, &selection), |event| {
        events.borrow_mut().push(event);
        false
    });
    let events = events.into_inner();
    assert!(matches!(events.last(), Some(HashEvent::Canceled { .. })));
    assert_eq!(terminal_count(&events), 1);
    assert!(backend.lock().active.is_none());
    assert!(backend.lock().completed.is_none());
    assert!(matches!(
        run(&backend, admit(&backend, &selection)).last(),
        Some(HashEvent::Completed { .. })
    ));
}
#[test]
fn panic_inside_worker_is_failed_once_and_retry_succeeds() {
    let (_fixture, backend, selection) = ready(b"abc");
    let events = RefCell::new(Vec::new());
    backend.run_job(admit(&backend, &selection), |event| {
        if matches!(event, HashEvent::Started { .. }) {
            panic!("injected worker failure");
        }
        events.borrow_mut().push(event);
        true
    });
    let events = events.into_inner();
    assert_eq!(terminal_count(&events), 1);
    assert!(
        matches!(events.last(), Some(HashEvent::Failed { error, .. }) if error.code == "INTERNAL")
    );
    assert!(backend.lock().active.is_none());
    assert!(matches!(
        run(&backend, admit(&backend, &selection)).last(),
        Some(HashEvent::Completed { .. })
    ));
}
#[test]
fn panic_while_sending_terminal_does_not_strand_resources() {
    let (_fixture, backend, selection) = ready(b"abc");
    backend.run_job(admit(&backend, &selection), |event| {
        assert!(
            !matches!(event, HashEvent::Completed { .. }),
            "injected terminal sink failure"
        );
        true
    });
    assert!(backend.lock().active.is_none());
    assert!(backend.begin_selection("main").is_ok());
}
#[test]
fn replaced_and_cleared_tokens_are_revoked() {
    let (fixture, backend, old) = ready(b"abc");
    let new = backend
        .begin_selection("main")
        .unwrap()
        .commit(files::prepare(&fixture.path).unwrap())
        .unwrap()
        .selection_id;
    assert_eq!(
        backend.details("main", &old).unwrap_err().code,
        "INVALID_SELECTION"
    );
    assert_eq!(
        backend
            .admit("main", &old, &["sha256".into()])
            .unwrap_err()
            .code,
        "INVALID_SELECTION"
    );
    backend.clear_selection("main", &new).unwrap();
    assert_eq!(
        backend.details("main", &new).unwrap_err().code,
        "INVALID_SELECTION"
    );
}
#[test]
fn wrong_window_unknown_job_and_unknown_selection_are_rejected() {
    let (_fixture, backend, selection) = ready(b"abc");
    assert_eq!(
        backend
            .admit("other", &selection, &["sha256".into()])
            .unwrap_err()
            .code,
        "INVALID_WINDOW"
    );
    assert_eq!(
        backend.details("other", &selection).unwrap_err().code,
        "INVALID_WINDOW"
    );
    assert_eq!(
        backend.cancel("other", "job-1").unwrap_err().code,
        "INVALID_WINDOW"
    );
    assert_eq!(
        backend.compare("other", "job-1", "").unwrap_err().code,
        "INVALID_WINDOW"
    );
    assert_eq!(
        backend
            .admit("main", "stale", &["sha256".into()])
            .unwrap_err()
            .code,
        "INVALID_SELECTION"
    );
    assert_eq!(
        backend
            .compare("main", "stale", &"a".repeat(513))
            .unwrap_err()
            .code,
        "INVALID_JOB"
    );
    assert_eq!(
        backend.cancel("main", "stale").unwrap_err().code,
        "INVALID_JOB"
    );
}
#[test]
fn picker_cancel_and_rejected_selection_preserve_previous_result() {
    let (_fixture, backend, selection) = ready(b"abc");
    let job = admit(&backend, &selection);
    let id = job.id.clone();
    run(&backend, job);
    let original = backend.lock().completed.as_ref().unwrap().results[0]
        .hex
        .clone();
    {
        let _permit = backend.begin_selection("main").unwrap();
        assert_eq!(
            backend
                .admit("main", &selection, &["sha256".into()])
                .unwrap_err()
                .code,
            "BUSY"
        );
    }
    assert_eq!(
        backend.compare("main", &id, &original).unwrap().verdict,
        Verdict::Match
    );
    assert!(backend.details("main", &selection).is_ok());
}
#[test]
fn beginning_new_job_or_replacing_selection_clears_old_results() {
    let (fixture, backend, selection) = ready(b"abc");
    let job = admit(&backend, &selection);
    let id = job.id.clone();
    run(&backend, job);
    let new_job = admit(&backend, &selection);
    assert_eq!(
        backend.compare("main", &id, "").unwrap_err().code,
        "INVALID_JOB"
    );
    run(&backend, new_job);
    backend
        .begin_selection("main")
        .unwrap()
        .commit(files::prepare(&fixture.path).unwrap())
        .unwrap();
    assert!(backend.lock().completed.is_none());
}
#[test]
fn vanished_file_fails_after_admission_and_releases_worker() {
    let (fixture, backend, selection) = ready(b"abc");
    let job = admit(&backend, &selection);
    fs::remove_file(&fixture.path).unwrap();
    let events = run(&backend, job);
    assert_eq!(events.len(), 1);
    assert!(
        matches!(events.last(), Some(HashEvent::Failed { error, .. }) if error.code == "NOT_FOUND")
    );
    assert!(backend.lock().active.is_none());
    assert!(backend.lock().completed.is_none());
}
#[test]
fn progress_is_ordered_and_throttled() {
    let (_fixture, backend, selection) = ready(&vec![0u8; 8 * 1024 * 1024]);
    let job = backend
        .admit(
            "main",
            &selection,
            &[
                "md5".into(),
                "sha1".into(),
                "sha256".into(),
                "sha512".into(),
            ],
        )
        .unwrap();
    let events = run(&backend, job);
    assert_eq!(terminal_count(&events), 1);
    let mut last_sequence = 0;
    let mut last_elapsed = 0;
    for event in events {
        let sequence = match event {
            HashEvent::Started { sequence, .. } | HashEvent::Completed { sequence, .. } => sequence,
            HashEvent::Progress {
                sequence,
                elapsed_ms,
                processed_bytes,
                ..
            } => {
                assert!(elapsed_ms >= last_elapsed + 99);
                last_elapsed = elapsed_ms;
                assert!(processed_bytes.parse::<u64>().unwrap() <= 8 * 1024 * 1024);
                sequence
            }
            _ => panic!("unexpected event"),
        };
        assert!(sequence > last_sequence);
        last_sequence = sequence;
    }
}
#[test]
fn closed_window_cancels_active_job_and_rejects_pending_selection() {
    let (_fixture, backend, selection) = ready(b"abc");
    let job = admit(&backend, &selection);
    backend.close_window("main");
    let events = run(&backend, job);
    assert!(matches!(events.last(), Some(HashEvent::Canceled { .. })));
    assert!(backend.lock().active.is_none());
    assert!(backend.lock().selection.is_none());
    assert!(backend.lock().completed.is_none());
    assert!(backend.begin_selection("main").is_err());
}

#[test]
fn clipboard_uses_only_latest_backend_results_in_canonical_order() {
    let (_fixture, backend, selection) = ready(b"abc");
    let job = backend
        .admit(
            "main",
            &selection,
            &["sha512".into(), "md5".into(), "sha256".into()],
        )
        .unwrap();
    let id = job.id.clone();
    assert!(backend.has_active_job());
    run(&backend, job);
    assert!(!backend.has_active_job());
    let text = backend.clipboard_text("main", &id, None).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 3);
    assert!(lines[0].starts_with("MD5: "));
    assert!(lines[1].starts_with("SHA-256: "));
    assert!(lines[2].starts_with("SHA-512: "));
    assert_eq!(
        backend
            .clipboard_text("main", &id, Some(Algorithm::Md5))
            .unwrap(),
        "900150983cd24fb0d6963f7d28e17f72"
    );
    assert_eq!(
        backend
            .clipboard_text("main", &id, Some(Algorithm::Sha1))
            .unwrap_err()
            .code,
        "INVALID_ALGORITHM"
    );
    assert_eq!(
        backend.clipboard_text("other", &id, None).unwrap_err().code,
        "INVALID_WINDOW"
    );
    backend.clear_selection("main", &selection).unwrap();
    assert_eq!(
        backend.clipboard_text("main", &id, None).unwrap_err().code,
        "INVALID_JOB"
    );
}
