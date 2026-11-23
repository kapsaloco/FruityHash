//! Bounded-memory, single-pass core. No paths, IPC, or UI dependencies.
use crate::{
    errors::{AppError, Result},
    types::{Algorithm, DigestResult},
};
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::{
    io::{ErrorKind, Read},
    sync::atomic::{AtomicBool, Ordering},
};

pub const BUFFER_SIZE: usize = 1024 * 1024;

#[derive(Debug)]
pub struct StreamResult {
    pub processed: u64,
    pub results: Vec<DigestResult>,
}

pub fn check_canceled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(AppError::canceled())
    } else {
        Ok(())
    }
}

pub fn checked_bytes(processed: u64, count: usize) -> Result<u64> {
    processed
        .checked_add(count.try_into().map_err(|_| AppError::internal())?)
        .ok_or_else(AppError::internal)
}

pub fn hash_reader<R: Read>(
    reader: &mut R,
    algorithms: &[Algorithm],
    expected_len: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64) -> Result<()>,
) -> Result<StreamResult> {
    if algorithms.is_empty() {
        return Err(AppError::algorithm());
    }
    check_canceled(cancel)?;
    let mut md5 = algorithms.contains(&Algorithm::Md5).then(Md5::new);
    let mut sha1 = algorithms.contains(&Algorithm::Sha1).then(Sha1::new);
    let mut sha256 = algorithms.contains(&Algorithm::Sha256).then(Sha256::new);
    let mut sha512 = algorithms.contains(&Algorithm::Sha512).then(Sha512::new);
    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut processed = 0;
    loop {
        check_canceled(cancel)?;
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(AppError::io(error)),
        };
        check_canceled(cancel)?;
        if count == 0 {
            break;
        }
        processed = checked_bytes(processed, count)?;
        if processed > expected_len {
            return Err(AppError::changed());
        }
        let bytes = &buffer[..count];
        if let Some(h) = &mut md5 {
            h.update(bytes);
        }
        if let Some(h) = &mut sha1 {
            h.update(bytes);
        }
        if let Some(h) = &mut sha256 {
            h.update(bytes);
        }
        if let Some(h) = &mut sha512 {
            h.update(bytes);
        }
        progress(processed)?;
    }
    if processed != expected_len {
        return Err(AppError::changed());
    }
    check_canceled(cancel)?;
    let mut results = Vec::with_capacity(4);
    // Canonical algorithm order regardless of selection order or duplicates.
    if let Some(h) = md5 {
        results.push(DigestResult {
            algorithm: Algorithm::Md5,
            hex: lower_hex(&h.finalize()),
        });
    }
    if let Some(h) = sha1 {
        results.push(DigestResult {
            algorithm: Algorithm::Sha1,
            hex: lower_hex(&h.finalize()),
        });
    }
    if let Some(h) = sha256 {
        results.push(DigestResult {
            algorithm: Algorithm::Sha256,
            hex: lower_hex(&h.finalize()),
        });
    }
    if let Some(h) = sha512 {
        results.push(DigestResult {
            algorithm: Algorithm::Sha512,
            hex: lower_hex(&h.finalize()),
        });
    }
    check_canceled(cancel)?;
    Ok(StreamResult { processed, results })
}

fn lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
