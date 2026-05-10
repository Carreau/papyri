use pyo3::prelude::*;
use pyo3::types::PyBytes;

mod pack;

#[pymodule]
fn papyri_pack(_py: Python, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(pack_bundle_fast, m)?)?;
    m.add_function(wrap_pyfunction!(gzip_compress, m)?)?;
    Ok(())
}

/// Fast end-to-end packing: read, validate, encode, compress, write to disk.
/// Returns (bytes_written, module_name-version).
#[pyfunction]
fn pack_bundle_fast(
    py: Python,
    bundle_dir: &str,
    output_path: &str,
    verbose: bool,
) -> PyResult<(usize, String)> {
    // Do all work outside GIL
    let result = py.allow_threads(|| {
        pack::pack_directory(bundle_dir, output_path, verbose)
    });

    match result {
        Ok((size, module, version)) => {
            let artifact_name = format!("{}-{}.papyri", module, version);
            Ok((size, artifact_name))
        }
        Err(e) => Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
            e.to_string(),
        )),
    }
}

/// High-speed gzip compression with deterministic output (mtime=0).
#[pyfunction]
fn gzip_compress(py: Python, data: &[u8]) -> PyResult<Py<PyBytes>> {
    // Do the work outside GIL
    let result = py.allow_threads(|| {
        pack::compress_gzip(data)
    });

    match result {
        Ok(compressed) => {
            let bytes = PyBytes::new_bound(py, &compressed);
            Ok(bytes.into())
        }
        Err(e) => Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
            e.to_string(),
        )),
    }
}
