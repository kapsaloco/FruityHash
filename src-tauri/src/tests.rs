use crate::{
    compare::{self, Verdict},
    errors::AppError,
    files,
    hashing::{self, BUFFER_SIZE},
    types::{Algorithm, DigestResult, HashEvent, SelectedFile},
};
use std::{
    fs,
    io::{self, Cursor, Read, Write},
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

const ABC: [&str; 4] = [
    "900150983cd24fb0d6963f7d28e17f72",
    "a9993e364706816aba3e25717850c26c9cd0d89d",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
];
const EMPTY: [&str; 4] = [
    "d41d8cd98f00b204e9800998ecf8427e",
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
];

pub(crate) struct Fixture {
    pub path: PathBuf,
}
impl Fixture {
    pub fn new(bytes: &[u8]) -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "fruityhash-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.write_all(bytes).unwrap();
        Self { path }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
fn hash(bytes: &[u8], algorithms: &[Algorithm]) -> Vec<DigestResult> {
    hashing::hash_reader(
        &mut Cursor::new(bytes),
        algorithms,
        bytes.len() as u64,
        &AtomicBool::new(false),
        |_| Ok(()),
    )
    .unwrap()
    .results
}

#[test]
fn standard_vectors_all_and_each_algorithm() {
    for (bytes, expected) in [(b"abc".as_slice(), ABC), (b"".as_slice(), EMPTY)] {
        let results = hash(bytes, &Algorithm::ALL);
        for (index, algorithm) in Algorithm::ALL.iter().enumerate() {
            assert_eq!(results[index].hex, expected[index]);
            assert_eq!(hash(bytes, &[*algorithm]), vec![results[index].clone()]);
        }
    }
}
#[test]
fn binary_bytes_are_not_decoded_or_normalized() {
    // Cross-checked independently with Python hashlib.
    let values = [
        "581841c8ec16537f6a05818d4cb129a5",
        "fb49d6f3fd21df24a4df6ae2b30939a1afc8e7a5",
        "72811e31f1383e723926a16ec6838e4e321f05b10d489e3eb4c1326751251988",
        "371a6fd10ee3d7a630770900c8bf631afef294eb82f5d4b456a33c6a7492f1cd6697dfa93e4b5ba3db01c87c05e9662ed0d78d187a987a5a9745fd97cdeab962",
    ];
    for (result, expected) in hash(b"\0\r\n\xff\x80abc\0", &Algorithm::ALL)
        .iter()
        .zip(values)
    {
        assert_eq!(result.hex, expected);
    }
}
#[test]
fn chunk_boundaries_and_fixed_read_buffer() {
    let expected = [
        "04713def0c5de392161b4cfc0ecd49623237c6438bc898d15bb6c55b345b7ccf",
        "4e29ad18ab9f42d7c233500771a39d7c852b200baf328fd00fbbe3fecea1eb56",
        "9ef018e955cacc77ab7f2bc97ef79ed1415f0a028b89d026f7bc3551479b1b5c",
    ];
    for (len, expected) in [BUFFER_SIZE - 1, BUFFER_SIZE, BUFFER_SIZE + 1]
        .into_iter()
        .zip(expected)
    {
        struct CheckedReader(Cursor<Vec<u8>>);
        impl Read for CheckedReader {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                assert_eq!(bytes.len(), BUFFER_SIZE);
                self.0.read(bytes)
            }
        }
        let mut reader = CheckedReader(Cursor::new(vec![b'A'; len]));
        let result = hashing::hash_reader(
            &mut reader,
            &[Algorithm::Sha256],
            len as u64,
            &AtomicBool::new(false),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(result.results[0].hex, expected);
    }
}
#[test]
fn interrupted_and_short_reads() {
    struct Short {
        bytes: Cursor<Vec<u8>>,
        interrupted: bool,
    }
    impl Read for Short {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if !self.interrupted {
                self.interrupted = true;
                return Err(io::ErrorKind::Interrupted.into());
            }
            self.bytes.read(&mut buffer[..1])
        }
    }
    let result = hashing::hash_reader(
        &mut Short {
            bytes: Cursor::new(b"abc".to_vec()),
            interrupted: false,
        },
        &Algorithm::ALL,
        3,
        &AtomicBool::new(false),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(result.results, hash(b"abc", &Algorithm::ALL));
}
#[test]
fn read_error_discards_partial_results() {
    struct Broken(bool);
    impl Read for Broken {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.0 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            self.0 = true;
            bytes[0] = b'a';
            Ok(1)
        }
    }
    let error = hashing::hash_reader(
        &mut Broken(false),
        &Algorithm::ALL,
        3,
        &AtomicBool::new(false),
        |_| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, "PERMISSION_DENIED");
}
#[test]
fn byte_count_mismatch_is_file_changed() {
    for expected_len in [2, 4] {
        let error = hashing::hash_reader(
            &mut Cursor::new(b"abc"),
            &Algorithm::ALL,
            expected_len,
            &AtomicBool::new(false),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code, "FILE_CHANGED");
    }
}
#[test]
fn cancellation_before_during_and_after_read() {
    let cancel = AtomicBool::new(true);
    assert_eq!(
        hashing::hash_reader(
            &mut Cursor::new(b"abc"),
            &Algorithm::ALL,
            3,
            &cancel,
            |_| Ok(())
        )
        .unwrap_err()
        .code,
        "CANCELED"
    );
    cancel.store(false, Ordering::Release);
    assert_eq!(
        hashing::hash_reader(
            &mut Cursor::new(b"abc"),
            &Algorithm::ALL,
            3,
            &cancel,
            |_| {
                cancel.store(true, Ordering::Release);
                Ok(())
            }
        )
        .unwrap_err()
        .code,
        "CANCELED"
    );
    struct CancelOnRead<'a>(&'a AtomicBool);
    impl Read for CancelOnRead<'_> {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            self.0.store(true, Ordering::Release);
            Ok(0)
        }
    }
    cancel.store(false, Ordering::Release);
    assert_eq!(
        hashing::hash_reader(
            &mut CancelOnRead(&cancel),
            &Algorithm::ALL,
            0,
            &cancel,
            |_| Ok(())
        )
        .unwrap_err()
        .code,
        "CANCELED"
    );
}
#[test]
fn final_progress_failure_does_not_expose_digests() {
    assert_eq!(
        hashing::hash_reader(
            &mut Cursor::new(b"abc"),
            &Algorithm::ALL,
            3,
            &AtomicBool::new(false),
            |_| Err(AppError::canceled())
        )
        .unwrap_err()
        .code,
        "CANCELED"
    );
}
#[test]
fn byte_arithmetic_above_four_gib_and_js_safe_integer() {
    assert_eq!(
        hashing::checked_bytes(4_294_967_296, 1).unwrap(),
        4_294_967_297
    );
    assert_eq!(
        hashing::checked_bytes(9_007_199_254_740_992, 1).unwrap(),
        9_007_199_254_740_993
    );
    assert_eq!(
        hashing::checked_bytes(u64::MAX, 1).unwrap_err().code,
        "INTERNAL"
    );
    let dto = SelectedFile {
        selection_id: "selection-1".into(),
        display_name: "test".into(),
        size_bytes: "9007199254740993".into(),
    };
    let json = serde_json::to_value(dto).unwrap();
    assert_eq!(json["sizeBytes"], "9007199254740993");
    assert!(json.get("pathDisplay").is_none());
}
#[test]
fn algorithms_are_allowlisted_deduplicated_and_ordered() {
    let names = ["sha512", "sha256", "sha256", "md5"].map(str::to_owned);
    assert_eq!(
        Algorithm::parse_list(&names).unwrap(),
        [Algorithm::Md5, Algorithm::Sha256, Algorithm::Sha512]
    );
    for names in [
        vec![],
        vec!["sha256".into(), "unknown".into()],
        vec!["SHA256".into()],
    ] {
        assert_eq!(
            Algorithm::parse_list(&names).unwrap_err().code,
            "INVALID_ALGORITHM"
        );
    }
    assert_eq!(
        hashing::hash_reader(
            &mut Cursor::new(b""),
            &[],
            0,
            &AtomicBool::new(false),
            |_| Ok(())
        )
        .unwrap_err()
        .code,
        "INVALID_ALGORITHM"
    );
}
#[test]
fn comparison_validates_raw_ascii_hex_only() {
    let results = hash(b"abc", &Algorithm::ALL);
    for result in &results {
        let comparison =
            compare::compare(&results, &format!(" \t{}\r\n", result.hex.to_uppercase()));
        assert_eq!(comparison.verdict, Verdict::Match);
        assert_eq!(comparison.algorithm, Some(result.algorithm));
        assert_eq!(
            compare::compare(&results, &"0".repeat(result.hex.len())).verdict,
            Verdict::Mismatch
        );
    }
    for text in [
        "".into(),
        "a".repeat(33),
        "0x123".into(),
        format!("{} file.zip", ABC[2]),
        format!("{} {}", &ABC[2][..32], &ABC[2][32..]),
        "ａ".repeat(64),
        format!("\u{a0}{}", ABC[2]),
        "a".repeat(513),
    ] {
        assert_eq!(
            compare::compare(&results, &text).verdict,
            Verdict::Invalid,
            "{text:?}"
        );
    }
    assert_eq!(
        compare::compare(&hash(b"abc", &[Algorithm::Sha256]), ABC[3]).verdict,
        Verdict::NotCalculated
    );
}
#[test]
fn real_file_and_missing_or_directory_errors() {
    let fixture = Fixture::new(b"abc");
    let cancel = AtomicBool::new(false);
    let results = files::hash_file(
        &fixture.path,
        &Algorithm::ALL,
        &cancel,
        |_| Ok(()),
        |_, _| Ok(()),
    )
    .unwrap();
    assert_eq!(results.results, hash(b"abc", &Algorithm::ALL));
    assert_eq!(
        files::prepare(&std::env::temp_dir()).unwrap_err().code,
        "NOT_REGULAR_FILE"
    );
    fs::remove_file(&fixture.path).unwrap();
    assert_eq!(files::prepare(&fixture.path).unwrap_err().code, "NOT_FOUND");
}
#[test]
fn truncation_growth_and_timestamp_changes_fail() {
    for bytes in [b"x".as_slice(), b"abcdef".as_slice(), b"xyz".as_slice()] {
        let fixture = Fixture::new(b"abc");
        let mut changed = false;
        let error = files::hash_file(
            &fixture.path,
            &Algorithm::ALL,
            &AtomicBool::new(false),
            |_| Ok(()),
            |_, _| {
                if !changed {
                    changed = true;
                    fs::write(&fixture.path, bytes).unwrap();
                    // Explicitly different mtime makes this deterministic on coarse filesystems.
                    let file = fs::OpenOptions::new()
                        .write(true)
                        .open(&fixture.path)
                        .unwrap();
                    file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1))
                        .unwrap();
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "FILE_CHANGED");
    }
}
#[cfg(unix)]
#[test]
fn symlink_target_registration_and_path_replacement() {
    use std::os::unix::fs::symlink;
    let target = Fixture::new(b"abc");
    let link = target.path.with_extension("link");
    symlink(&target.path, &link).unwrap();
    assert_eq!(
        files::prepare(&link).unwrap().path,
        fs::canonicalize(&target.path).unwrap()
    );
    fs::remove_file(link).unwrap();
    let replacement = Fixture::new(b"abc");
    let error = files::hash_file(
        &target.path,
        &Algorithm::ALL,
        &AtomicBool::new(false),
        |_| Ok(()),
        |_, _| {
            fs::rename(&replacement.path, &target.path).unwrap();
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "FILE_CHANGED");
}
#[test]
fn channel_event_serialization_matches_the_frontend_contract() {
    let event = HashEvent::Progress {
        job_id: "job-2".into(),
        sequence: 2,
        processed_bytes: "9007199254740993".into(),
        total_bytes: "18446744073709551615".into(),
        elapsed_ms: 200,
    };
    let value = serde_json::to_value(event).unwrap();
    assert_eq!(value["type"], "progress");
    assert_eq!(value["jobId"], "job-2");
    assert_eq!(value["processedBytes"], "9007199254740993");
    assert_eq!(value["totalBytes"], u64::MAX.to_string());
    assert!(value.get("job_id").is_none());
}
