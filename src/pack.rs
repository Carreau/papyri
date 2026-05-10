use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use rayon::prelude::*;

#[derive(Debug)]
pub enum PackError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Validation(String),
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            PackError::Io(e) => write!(f, "IO error: {}", e),
            PackError::Json(e) => write!(f, "JSON error: {}", e),
            PackError::Validation(e) => write!(f, "Validation error: {}", e),
        }
    }
}

impl From<std::io::Error> for PackError {
    fn from(err: std::io::Error) -> Self {
        PackError::Io(err)
    }
}

impl From<serde_json::Error> for PackError {
    fn from(err: serde_json::Error) -> Self {
        PackError::Json(err)
    }
}

/// Read all JSON files from a directory in parallel.
/// Returns a Vec of (filename, parsed JSON) tuples.
pub fn read_directory_into_json_dicts(
    directory: &str,
) -> Result<Vec<(String, Value)>, PackError> {
    let path = Path::new(directory);

    if !path.is_dir() {
        return Ok(Vec::new());
    }

    // Collect file paths
    let entries: Result<Vec<_>, _> = fs::read_dir(path)?
        .filter_map(|e| {
            match e {
                Ok(entry) => {
                    let path = entry.path();
                    if path.is_file() {
                        Some(Ok(path))
                    } else {
                        None
                    }
                }
                Err(e) => Some(Err(e)),
            }
        })
        .collect();

    let paths = entries?;

    // Parse JSON files in parallel
    let results: Result<Vec<_>, PackError> = paths
        .par_iter()
        .map(|path| {
            let content = fs::read_to_string(path)?;
            let json: Value = serde_json::from_str(&content)?;

            let key = path.file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();

            Ok((key, json))
        })
        .collect();

    results
}

/// High-speed gzip compression with deterministic output (mtime=0).
/// This matches Python's gzip.GzipFile(mtime=0) for reproducible builds.
pub fn compress_gzip(data: &[u8]) -> Result<Vec<u8>, PackError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(data)?;
    encoder.finish().map_err(|e| PackError::Io(e))
}
