use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

mod pack;

#[pymodule]
fn papyri_pack(_py: Python, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(read_bundle_json_parallel, m)?)?;
    m.add_function(wrap_pyfunction!(gzip_compress, m)?)?;
    Ok(())
}

/// Read and parse all JSON files in a directory in parallel, return as dicts.
/// This optimizes the I/O-bound JSON parsing phase.
#[pyfunction]
fn read_bundle_json_parallel(py: Python, directory: &str) -> PyResult<PyObject> {
    // Do the work outside GIL
    let result = py.allow_threads(|| {
        pack::read_directory_into_json_dicts(directory)
    });

    match result {
        Ok(result_vec) => {
            let dict = PyDict::new_bound(py);
            for (key, json_value) in result_vec {
                let py_value = json_to_pyobject(py, &json_value)?;
                dict.set_item(key, py_value)?;
            }
            Ok(dict.into())
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

fn json_to_pyobject(py: Python, value: &serde_json::Value) -> PyResult<PyObject> {
    use serde_json::Value;

    match value {
        Value::Null => Ok(py.None()),
        Value::Bool(b) => Ok(b.to_object(py)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.to_object(py))
            } else if let Some(u) = n.as_u64() {
                Ok(u.to_object(py))
            } else {
                Ok(n.as_f64().unwrap().to_object(py))
            }
        }
        Value::String(s) => Ok(s.to_object(py)),
        Value::Array(arr) => {
            let list = PyList::empty_bound(py);
            for item in arr {
                list.append(json_to_pyobject(py, item)?)?;
            }
            Ok(list.into())
        }
        Value::Object(map) => {
            let dict = PyDict::new_bound(py);
            for (k, v) in map {
                dict.set_item(k, json_to_pyobject(py, v)?)?;
            }
            Ok(dict.into())
        }
    }
}
