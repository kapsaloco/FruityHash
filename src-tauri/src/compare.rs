use crate::types::{Algorithm, DigestResult};
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Match,
    Mismatch,
    Invalid,
    NotCalculated,
}
#[derive(Debug, Serialize)]
pub struct Comparison {
    pub algorithm: Option<Algorithm>,
    pub verdict: Verdict,
}

pub fn compare(results: &[DigestResult], expected: &str) -> Comparison {
    let invalid = || Comparison {
        algorithm: None,
        verdict: Verdict::Invalid,
    };
    if expected.len() > 512 {
        return invalid();
    }
    let expected = expected.trim_matches(|c: char| c.is_ascii_whitespace());
    if !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return invalid();
    }
    let algorithm = match expected.len() {
        32 => Algorithm::Md5,
        40 => Algorithm::Sha1,
        64 => Algorithm::Sha256,
        128 => Algorithm::Sha512,
        _ => return invalid(),
    };
    let verdict = match results.iter().find(|result| result.algorithm == algorithm) {
        Some(result) if result.hex.eq_ignore_ascii_case(expected) => Verdict::Match,
        Some(_) => Verdict::Mismatch,
        None => Verdict::NotCalculated,
    };
    Comparison {
        algorithm: Some(algorithm),
        verdict,
    }
}
