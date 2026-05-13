mod db;
mod ir;
mod render;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    extract::{Path as AxPath, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};
use clap::Parser;
use maud::{html, Markup};

use crate::db::Index;
use crate::ir::Bundle;

#[derive(Parser, Debug)]
#[command(about = "Rust prototype viewer for papyri DocBundles")]
struct Cli {
    /// One or more .papyri files to load.
    #[arg(required = true)]
    bundles: Vec<PathBuf>,
    #[arg(long, default_value = "127.0.0.1:8765")]
    bind: SocketAddr,
}

struct AppState {
    bundles: HashMap<String, Bundle>,
    index: Index,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,tower_http=info".into()))
        .init();

    let cli = Cli::parse();
    let mut bundles = HashMap::new();
    let index = Index::open_in_memory()?;
    for path in &cli.bundles {
        let b = ir::load_papyri(path).with_context(|| format!("load {}", path.display()))?;
        tracing::info!(module = %b.module, version = %b.version, "loaded bundle");
        index.ingest(&b)?;
        bundles.insert(b.module.clone(), b);
    }

    let state = Arc::new(AppState { bundles, index });

    let app = Router::new()
        .route("/", get(home))
        .route("/m/:module", get(module_index))
        .route("/m/:module/api/*qa", get(api_page))
        .route("/m/:module/n/*key", get(narrative_page))
        .route("/search", get(search))
        .with_state(state);

    tracing::info!(addr = %cli.bind, "listening");
    let listener = tokio::net::TcpListener::bind(cli.bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

// ---- handlers --------------------------------------------------------------

async fn home(State(s): State<Arc<AppState>>) -> Markup {
    let body = html! {
        h1 { "papyri-rs" }
        p.summary { "Loaded bundles. Pick one." }
        form action="/search" method="get" {
            input type="search" name="q" placeholder="search symbols…" autofocus;
            button type="submit" { "search" }
        }
        ul.entries {
            @for (name, b) in &s.bundles {
                li {
                    a href={ "/m/" (name) } { code { (name) } }
                    span.tag { (b.version) }
                }
            }
        }
    };
    render::layout("Home", "all bundles", body)
}

async fn module_index(
    State(s): State<Arc<AppState>>,
    AxPath(module): AxPath<String>,
) -> Result<Markup, StatusCode> {
    let b = s.bundles.get(&module).ok_or(StatusCode::NOT_FOUND)?;
    Ok(render::layout(&b.module, &b.module, render::index(b)))
}

async fn api_page(
    State(s): State<Arc<AppState>>,
    AxPath((module, qa)): AxPath<(String, String)>,
) -> Result<Markup, StatusCode> {
    let b = s.bundles.get(&module).ok_or(StatusCode::NOT_FOUND)?;
    let doc = b.api.get(&qa).ok_or(StatusCode::NOT_FOUND)?;
    Ok(render::layout(&qa, &b.module, render::symbol_page(&qa, doc)))
}

async fn narrative_page(
    State(s): State<Arc<AppState>>,
    AxPath((module, key)): AxPath<(String, String)>,
) -> Result<Markup, StatusCode> {
    let b = s.bundles.get(&module).ok_or(StatusCode::NOT_FOUND)?;
    let doc = b.narrative.get(&key).ok_or(StatusCode::NOT_FOUND)?;
    Ok(render::layout(&key, &b.module, render::narrative_page(&key, doc)))
}

#[derive(serde::Deserialize)]
struct SearchQ {
    q: Option<String>,
}

async fn search(
    State(s): State<Arc<AppState>>,
    Query(q): Query<SearchQ>,
) -> impl IntoResponse {
    let query = q.q.unwrap_or_default();
    let results = s.index.search(&query).unwrap_or_default();
    let body = html! {
        h1 { "Search" }
        form action="/search" method="get" {
            input type="search" name="q" value=(query) autofocus;
            button type="submit" { "search" }
        }
        @if results.is_empty() {
            p.meta { "No matches." }
        } @else {
            ul.entries {
                @for (bundle, qa) in &results {
                    li {
                        a href={ "/m/" (bundle) "/api/" (qa) } { code { (qa) } }
                        span.tag { (bundle) }
                    }
                }
            }
        }
    };
    render::layout("Search", "all bundles", body)
}
