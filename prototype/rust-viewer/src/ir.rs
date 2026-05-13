//! Decode a `.papyri` artifact (gzip + canonical CBOR) into typed IR nodes.
//!
//! Field order mirrors `ingest/src/encoder.ts::FIELD_ORDER` — the single
//! source of truth on the TS side. Each CBOR tag wraps a positional array.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use ciborium::value::Value;
use flate2::read::GzDecoder;

/// Every IR node we care about for the prototype. Unknown tags become
/// `Node::Unknown` so the renderer can show a placeholder instead of crashing.
#[derive(Debug, Clone)]
pub enum Node {
    Text(String),
    Paragraph(Vec<Node>),
    Heading { depth: u8, children: Vec<Node> },
    Section { children: Vec<Node>, title: Option<String>, level: u8 },
    InlineCode(String),
    Code { value: String, status: Option<String> },
    Emphasis(Vec<Node>),
    Strong(Vec<Node>),
    Link { children: Vec<Node>, url: String, title: Option<String> },
    BulletList { ordered: bool, start: i64, spread: bool, children: Vec<Node> },
    ListItem { spread: bool, children: Vec<Node> },
    ThematicBreak,
    Directive { name: String, value: Option<String>, children: Vec<Node> },
    Unknown { tag: u64 },
}

#[derive(Debug, Clone)]
pub struct SigParam {
    pub name: String,
    pub annotation: Option<String>,
    pub kind: String,
    pub default: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Signature {
    pub kind: String,
    pub parameters: Vec<SigParam>,
    pub return_annotation: Option<String>,
    pub target_name: String,
}

#[derive(Debug, Clone)]
pub struct GeneratedDoc {
    pub content: BTreeMap<String, Node>,
    pub ordered_sections: Vec<String>,
    pub item_file: Option<String>,
    pub item_line: Option<i64>,
    pub item_type: Option<String>,
    pub signature: Option<Signature>,
}

#[derive(Debug, Clone)]
pub struct TocEntry {
    pub title: String,
    pub reference: Option<String>,
    pub children: Vec<TocEntry>,
}

#[derive(Debug, Clone)]
pub struct Bundle {
    pub module: String,
    pub version: String,
    pub summary: String,
    pub github_slug: String,
    pub tag: String,
    pub api: BTreeMap<String, GeneratedDoc>,
    pub narrative: BTreeMap<String, GeneratedDoc>,
    pub toc: Vec<TocEntry>,
}

// ---- entry point -----------------------------------------------------------

pub fn load_papyri(path: &Path) -> Result<Bundle> {
    let mut f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut gz = Vec::new();
    f.read_to_end(&mut gz)?;
    let mut decoder = GzDecoder::new(&gz[..]);
    let mut raw = Vec::new();
    decoder.read_to_end(&mut raw).context("gunzip")?;
    let value: Value = ciborium::from_reader(&raw[..]).context("cbor decode")?;
    decode_bundle(value)
}

// ---- helpers ---------------------------------------------------------------

fn as_tag(v: &Value) -> Option<(u64, &Value)> {
    if let Value::Tag(tag, inner) = v {
        Some((*tag, inner.as_ref()))
    } else {
        None
    }
}

fn as_array(v: &Value) -> Result<&Vec<Value>> {
    match v {
        Value::Array(a) => Ok(a),
        _ => bail!("expected array, got {:?}", v),
    }
}

fn as_text_opt(v: &Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s.clone()),
        Value::Null => None,
        _ => None,
    }
}

fn as_text(v: &Value) -> Result<String> {
    as_text_opt(v).ok_or_else(|| anyhow!("expected text, got {:?}", v))
}

fn as_int(v: &Value) -> Option<i64> {
    match v {
        Value::Integer(i) => i64::try_from(*i).ok(),
        _ => None,
    }
}

fn as_bool(v: &Value) -> bool {
    matches!(v, Value::Bool(true))
}

fn decode_nodes(v: &Value) -> Vec<Node> {
    match v {
        Value::Array(a) => a.iter().map(decode_node).collect(),
        _ => vec![],
    }
}

fn decode_node(v: &Value) -> Node {
    let (tag, inner) = match as_tag(v) {
        Some(x) => x,
        None => return Node::Unknown { tag: 0 },
    };
    let fields = match inner {
        Value::Array(a) => a.as_slice(),
        _ => return Node::Unknown { tag },
    };
    match tag {
        4046 => Node::Text(fields.first().and_then(as_text_opt).unwrap_or_default()),
        4045 => Node::Paragraph(decode_nodes(&fields[0])),
        4020 => Node::Heading {
            depth: as_int(&fields[0]).unwrap_or(1) as u8,
            children: decode_nodes(&fields[1]),
        },
        4015 => Node::Section {
            children: decode_nodes(&fields[0]),
            title: as_text_opt(&fields[1]),
            level: as_int(&fields[2]).unwrap_or(0) as u8,
        },
        4051 => Node::InlineCode(fields.first().and_then(as_text_opt).unwrap_or_default()),
        4050 => Node::Code {
            value: as_text_opt(&fields[0]).unwrap_or_default(),
            status: fields.get(1).and_then(as_text_opt),
        },
        4047 => Node::Emphasis(decode_nodes(&fields[0])),
        4048 => Node::Strong(decode_nodes(&fields[0])),
        4049 => Node::Link {
            children: decode_nodes(&fields[0]),
            url: as_text_opt(&fields[1]).unwrap_or_default(),
            title: fields.get(2).and_then(as_text_opt),
        },
        4053 => Node::BulletList {
            ordered: as_bool(&fields[0]),
            start: as_int(&fields[1]).unwrap_or(1),
            spread: as_bool(&fields[2]),
            children: decode_nodes(&fields[3]),
        },
        4054 => Node::ListItem {
            spread: as_bool(&fields[0]),
            children: decode_nodes(&fields[1]),
        },
        4019 => Node::ThematicBreak,
        4052 => Node::Directive {
            name: as_text_opt(&fields[0]).unwrap_or_default(),
            value: fields.get(3).and_then(as_text_opt),
            children: fields.get(4).map(decode_nodes).unwrap_or_default(),
        },
        _ => Node::Unknown { tag },
    }
}

fn decode_signature(v: &Value) -> Option<Signature> {
    let (tag, inner) = as_tag(v)?;
    if tag != 4029 {
        return None;
    }
    let f = match inner {
        Value::Array(a) => a,
        _ => return None,
    };
    let parameters = match &f[1] {
        Value::Array(a) => a
            .iter()
            .filter_map(|p| {
                let (t, i) = as_tag(p)?;
                if t != 4030 {
                    return None;
                }
                let pf = match i {
                    Value::Array(a) => a,
                    _ => return None,
                };
                Some(SigParam {
                    name: as_text_opt(&pf[0]).unwrap_or_default(),
                    annotation: as_text_opt(&pf[1]),
                    kind: as_text_opt(&pf[2]).unwrap_or_default(),
                    default: as_text_opt(&pf[3]),
                })
            })
            .collect(),
        _ => vec![],
    };
    Some(Signature {
        kind: as_text_opt(&f[0]).unwrap_or_default(),
        parameters,
        return_annotation: as_text_opt(&f[2]),
        target_name: as_text_opt(&f[3]).unwrap_or_default(),
    })
}

fn decode_generated_doc(v: &Value) -> Result<GeneratedDoc> {
    let (tag, inner) = as_tag(v).ok_or_else(|| anyhow!("not a tagged value"))?;
    if tag != 4011 {
        bail!("expected GeneratedDoc (4011), got {}", tag);
    }
    let f = as_array(inner)?;
    let mut content = BTreeMap::new();
    if let Value::Map(map) = &f[0] {
        for (k, vv) in map {
            if let Value::Text(name) = k {
                content.insert(name.clone(), decode_node(vv));
            }
        }
    }
    let ordered_sections = match &f[2] {
        Value::Array(a) => a.iter().filter_map(as_text_opt).collect(),
        _ => vec![],
    };
    Ok(GeneratedDoc {
        content,
        ordered_sections,
        item_file: as_text_opt(&f[3]),
        item_line: as_int(&f[4]),
        item_type: as_text_opt(&f[5]),
        signature: decode_signature(&f[8]),
    })
}

fn decode_toc_entry(v: &Value) -> Option<TocEntry> {
    let (tag, inner) = as_tag(v)?;
    if tag != 4021 {
        return None;
    }
    let f = match inner {
        Value::Array(a) => a,
        _ => return None,
    };
    let children = match &f[0] {
        Value::Array(a) => a.iter().filter_map(decode_toc_entry).collect(),
        _ => vec![],
    };
    Some(TocEntry {
        title: as_text_opt(&f[1]).unwrap_or_default(),
        reference: as_text_opt(&f[2]),
        children,
    })
}

fn decode_bundle(v: Value) -> Result<Bundle> {
    let (tag, inner) = as_tag(&v).ok_or_else(|| anyhow!("root is not a tagged value"))?;
    if tag != 4070 {
        bail!("expected Bundle (4070), got {}", tag);
    }
    let f = as_array(inner)?;
    // 0 pack_format_version, 1 ir_schema_version, 2 module, 3 version,
    // 4 summary, 5 github_slug, 6 tag, 7 logo, 8 aliases, 9 extra,
    // 10 api, 11 narrative, 12 examples, 13 assets, 14 toc
    let read_doc_map = |idx: usize| -> Result<BTreeMap<String, GeneratedDoc>> {
        let mut out = BTreeMap::new();
        if let Value::Map(m) = &f[idx] {
            for (k, v) in m {
                if let Value::Text(name) = k {
                    out.insert(name.clone(), decode_generated_doc(v)?);
                }
            }
        }
        Ok(out)
    };
    let toc = match f.get(14) {
        Some(Value::Array(a)) => a.iter().filter_map(decode_toc_entry).collect(),
        _ => vec![],
    };
    Ok(Bundle {
        module: as_text(&f[2])?,
        version: as_text(&f[3])?,
        summary: as_text_opt(&f[4]).unwrap_or_default(),
        github_slug: as_text_opt(&f[5]).unwrap_or_default(),
        tag: as_text_opt(&f[6]).unwrap_or_default(),
        api: read_doc_map(10)?,
        narrative: read_doc_map(11)?,
        toc,
    })
}
