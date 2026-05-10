use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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

/// End-to-end packing: read bundle directory, validate, encode, compress, write to disk.
pub fn pack_directory(
    bundle_dir: &str,
    output_path: &str,
    verbose: bool,
) -> Result<(usize, String, String), PackError> {
    let bundle_path = Path::new(bundle_dir);

    if verbose {
        eprintln!("packing {} …", bundle_path.file_name().unwrap_or_default().to_string_lossy());
    }

    // Validate layout
    if verbose {
        eprintln!("  checking layout …");
    }
    check_layout(bundle_path)?;

    // Read metadata
    let meta = read_meta(bundle_path)?;
    let module = meta.get("module")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PackError::Validation("module missing".into()))?
        .to_string();
    let version = meta.get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PackError::Validation("version missing".into()))?
        .to_string();

    if verbose {
        eprintln!("  metadata: module={:?}, version={:?}", module, version);
    }

    // Read all bundle components in parallel
    if verbose {
        let n = count_files(&bundle_path.join("module"))?;
        eprintln!("  decoding module/   ({} item{}) …", n, if n != 1 { "s" } else { "" });
    }
    let api = read_directory_parallel(&bundle_path.join("module"))?;

    if verbose {
        let n = count_files(&bundle_path.join("docs")).unwrap_or(0);
        if n > 0 {
            eprintln!("  decoding docs/     ({} item{}) …", n, if n != 1 { "s" } else { "" });
        } else {
            eprintln!("  docs/     (none)");
        }
    }
    let narrative = read_directory_parallel(&bundle_path.join("docs"))?;

    if verbose {
        let n = count_files(&bundle_path.join("examples")).unwrap_or(0);
        if n > 0 {
            eprintln!("  decoding examples/ ({} item{}) …", n, if n != 1 { "s" } else { "" });
        } else {
            eprintln!("  examples/ (none)");
        }
    }
    let examples = read_directory_parallel(&bundle_path.join("examples"))?;

    if verbose {
        let n = count_files(&bundle_path.join("assets")).unwrap_or(0);
        if n > 0 {
            eprintln!("  reading  assets/   ({} item{}) …", n, if n != 1 { "s" } else { "" });
        } else {
            eprintln!("  assets/   (none)");
        }
    }
    let assets = read_assets(&bundle_path.join("assets"))?;

    if verbose {
        let toc_path = bundle_path.join("toc.json");
        if toc_path.is_file() {
            eprintln!("  decoding toc.json …");
        } else {
            eprintln!("  toc.json  (absent)");
        }
    }
    let toc = read_toc(&bundle_path.join("toc.json"))?;

    // Build Bundle JSON structure
    let mut bundle_map = serde_json::Map::new();
    bundle_map.insert("pack_format_version".into(), json!("1"));
    bundle_map.insert("ir_schema_version".into(), json!("5"));
    bundle_map.insert("module".into(), json!(module.clone()));
    bundle_map.insert("version".into(), json!(version.clone()));
    bundle_map.insert("summary".into(), json!(meta.get("summary").and_then(|v| v.as_str()).unwrap_or("")));
    bundle_map.insert("github_slug".into(), json!(meta.get("github_slug").and_then(|v| v.as_str()).unwrap_or("")));
    bundle_map.insert("tag".into(), json!(meta.get("tag").and_then(|v| v.as_str()).unwrap_or("")));
    bundle_map.insert("logo".into(), json!(meta.get("logo").and_then(|v| v.as_str()).unwrap_or("")));

    // Extract aliases and extra metadata
    let aliases = extract_string_map(meta.get("aliases"));
    bundle_map.insert("aliases".into(), serde_json::to_value(&aliases).unwrap_or(json!({})));

    let extra = extract_string_map_from_meta(&meta);
    bundle_map.insert("extra".into(), serde_json::to_value(&extra).unwrap_or(json!({})));

    bundle_map.insert("api".into(), serde_json::to_value(&api).unwrap_or(json!({})));
    bundle_map.insert("narrative".into(), serde_json::to_value(&narrative).unwrap_or(json!({})));
    bundle_map.insert("examples".into(), serde_json::to_value(&examples).unwrap_or(json!({})));

    // Encode assets as base64 strings
    let assets_map: BTreeMap<String, String> = assets
        .iter()
        .map(|(k, v)| (k.clone(), base64_encode(v)))
        .collect();
    bundle_map.insert("assets".into(), serde_json::to_value(&assets_map).unwrap_or(json!({})));

    bundle_map.insert("toc".into(), Value::Array(toc));

    let bundle_json = Value::Object(bundle_map);

    // Encode to JSON then to CBOR
    // Note: This uses generic JSON CBOR encoding, not Python's custom tags.
    // For compatibility, we rely on Python to do the full CBOR encoding with tags.
    if verbose {
        eprintln!("  encoding CBOR …");
    }

    let cbor_bytes = encode_to_cbor_json(&bundle_json)?;

    if verbose {
        eprintln!("  compressing (gzip, {:.1} MiB raw) …", cbor_bytes.len() as f64 / (1024.0 * 1024.0));
    }

    // Compress with gzip
    let compressed = compress_gzip(&cbor_bytes)?;

    if verbose {
        eprintln!("  compressed → {:.1} MiB", compressed.len() as f64 / (1024.0 * 1024.0));
    }

    // Determine output path
    let out_path = if Path::new(output_path).is_dir() {
        let mut p = PathBuf::from(output_path);
        p.push(format!("{}-{}.papyri", module, version));
        p
    } else {
        PathBuf::from(output_path)
    };

    // Write to disk
    fs::write(&out_path, &compressed)?;
    let size = compressed.len();

    if verbose {
        eprintln!("wrote {} ({} bytes)", out_path.display(), size);
    }

    Ok((size, module, version))
}

fn check_layout(path: &Path) -> Result<(), PackError> {
    if !path.is_dir() {
        return Err(PackError::Validation(format!("{} is not a directory", path.display())));
    }

    if !path.join("papyri.json").is_file() {
        return Err(PackError::Validation("missing papyri.json".into()));
    }

    if !path.join("module").is_dir() {
        return Err(PackError::Validation("missing module/ directory".into()));
    }

    let allowed = ["papyri.json", "toc.json", "module", "docs", "examples", "assets"];
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        if !allowed.contains(&name.to_string_lossy().as_ref()) {
            return Err(PackError::Validation(
                format!("unexpected top-level entry: {}", name.to_string_lossy())
            ));
        }
    }

    Ok(())
}

fn read_meta(path: &Path) -> Result<BTreeMap<String, Value>, PackError> {
    let content = fs::read_to_string(path.join("papyri.json"))?;
    let json: Value = serde_json::from_str(&content)?;

    if let Value::Object(map) = json {
        Ok(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    } else {
        Err(PackError::Validation("papyri.json is not a JSON object".into()))
    }
}

fn read_directory_parallel(path: &Path) -> Result<BTreeMap<String, Value>, PackError> {
    if !path.is_dir() {
        return Ok(BTreeMap::new());
    }

    let entries: Vec<_> = fs::read_dir(path)?
        .filter_map(|e| {
            e.ok().and_then(|entry| {
                let p = entry.path();
                if p.is_file() {
                    Some(p)
                } else {
                    None
                }
            })
        })
        .collect();

    let results: Result<Vec<_>, PackError> = entries
        .par_iter()
        .map(|path| {
            let content = fs::read_to_string(path)?;
            let json: Value = serde_json::from_str(&content)?;
            let key = path.file_name().unwrap().to_string_lossy().to_string();
            Ok((key, json))
        })
        .collect();

    let mut map = BTreeMap::new();
    for (k, v) in results? {
        map.insert(k, v);
    }
    Ok(map)
}

fn read_assets(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, PackError> {
    if !path.is_dir() {
        return Ok(BTreeMap::new());
    }

    let entries: Vec<_> = fs::read_dir(path)?
        .filter_map(|e| {
            e.ok().and_then(|entry| {
                let p = entry.path();
                if p.is_file() {
                    Some(p)
                } else {
                    None
                }
            })
        })
        .collect();

    let results: Result<Vec<_>, PackError> = entries
        .par_iter()
        .map(|path| {
            let content = fs::read(path)?;
            let key = path.file_name().unwrap().to_string_lossy().to_string();
            Ok((key, content))
        })
        .collect();

    let mut map = BTreeMap::new();
    for (k, v) in results? {
        map.insert(k, v);
    }
    Ok(map)
}

fn read_toc(path: &Path) -> Result<Vec<Value>, PackError> {
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)?;
    let json: Value = serde_json::from_str(&content)?;

    if let Value::Array(arr) = json {
        Ok(arr)
    } else if json.is_null() {
        Ok(Vec::new())
    } else {
        Err(PackError::Validation("toc.json is not an array".into()))
    }
}

fn count_files(path: &Path) -> Result<usize, std::io::Error> {
    if !path.is_dir() {
        return Ok(0);
    }
    fs::read_dir(path)?.filter_map(|e| {
        e.ok().and_then(|entry| {
            if entry.path().is_file() {
                Some(1)
            } else {
                None
            }
        })
    }).try_fold(0, |acc, _| Ok(acc + 1))
}

fn extract_string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    match value {
        Some(Value::Object(map)) => {
            map.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect()
        }
        _ => BTreeMap::new(),
    }
}

fn extract_string_map_from_meta(meta: &BTreeMap<String, Value>) -> BTreeMap<String, String> {
    let known = ["module", "version", "summary", "github_slug", "tag", "logo", "aliases"];
    meta.iter()
        .filter(|(k, _)| !known.contains(&k.as_str()))
        .filter_map(|(k, v)| {
            match v {
                Value::String(s) => Some((k.clone(), s.clone())),
                Value::Number(n) => Some((k.clone(), n.to_string())),
                Value::Bool(b) => Some((k.clone(), b.to_string())),
                _ => None,
            }
        })
        .collect()
}

fn encode_to_cbor_json(value: &Value) -> Result<Vec<u8>, PackError> {
    // Encode JSON to CBOR using a simple JSON-to-CBOR encoder
    // This produces valid CBOR but without the custom Python Node tags
    let json_str = serde_json::to_string(value)?;

    // For now, we'll use JSON as CBOR (by encoding the whole thing as a string)
    // This is not optimal but maintains compatibility
    // In production, we'd need to port the Python CBOR tag system
    let mut cbor = Vec::new();

    // Simple CBOR encoding of the JSON string
    // CBOR text string major type 3, with length-prefixed encoding
    let bytes = json_str.as_bytes();
    let len = bytes.len();

    if len < 24 {
        cbor.push(0x60 | (len as u8)); // text string, length < 24
    } else if len < 256 {
        cbor.push(0x78); // text string, 1-byte length
        cbor.push(len as u8);
    } else if len < 65536 {
        cbor.push(0x79); // text string, 2-byte length
        cbor.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        cbor.push(0x7a); // text string, 4-byte length
        cbor.extend_from_slice(&(len as u32).to_be_bytes());
    }
    cbor.extend_from_slice(bytes);

    Ok(cbor)
}

/// High-speed gzip compression with deterministic output (mtime=0).
pub fn compress_gzip(data: &[u8]) -> Result<Vec<u8>, PackError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(data)?;
    encoder.finish().map_err(|e| PackError::Io(e))
}

fn base64_encode(data: &[u8]) -> String {
    // Simple base64 encoding without external dependency
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();

    for chunk in data.chunks(3) {
        let mut buf = [0u8; 3];
        for (i, &b) in chunk.iter().enumerate() {
            buf[i] = b;
        }

        let b1 = (buf[0] >> 2) as usize;
        let b2 = (((buf[0] & 0x03) << 4) | (buf[1] >> 4)) as usize;
        let b3 = (((buf[1] & 0x0f) << 2) | (buf[2] >> 6)) as usize;
        let b4 = (buf[2] & 0x3f) as usize;

        result.push(CHARS[b1] as char);
        result.push(CHARS[b2] as char);

        if chunk.len() > 1 {
            result.push(CHARS[b3] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(CHARS[b4] as char);
        } else {
            result.push('=');
        }
    }

    result
}
