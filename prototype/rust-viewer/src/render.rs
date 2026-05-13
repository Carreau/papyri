//! Walk the IR into HTML using `maud`. No JS, no hydration.

use maud::{html, Markup, DOCTYPE};

use crate::ir::{Bundle, GeneratedDoc, Node, Signature};

pub fn layout(title: &str, module: &str, body: Markup) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { (title) " · " (module) }
                style { (include_str!("../templates/style.css")) }
            }
            body {
                header.topbar {
                    a.brand href="/" { "papyri-rs" }
                    span.module { (module) }
                }
                main { (body) }
                footer { "Rust prototype · server-rendered, no JS" }
            }
        }
    }
}

pub fn index(bundle: &Bundle) -> Markup {
    html! {
        h1 { (bundle.module) " " span.version { (bundle.version) } }
        @if !bundle.summary.is_empty() {
            p.summary { (bundle.summary) }
        }
        @if !bundle.narrative.is_empty() {
            h2 { "Narrative" }
            ul.entries {
                @for key in bundle.narrative.keys() {
                    li { a href={ "/n/" (key) } { (key) } }
                }
            }
        }
        h2 { "API" }
        ul.entries {
            @for (qa, doc) in &bundle.api {
                li {
                    a href={ "/api/" (qa) } { code { (qa) } }
                    @if let Some(t) = &doc.item_type {
                        span.tag { (t) }
                    }
                }
            }
        }
    }
}

pub fn symbol_page(qa: &str, doc: &GeneratedDoc) -> Markup {
    html! {
        h1 { code { (qa) } }
        @if let Some(sig) = &doc.signature {
            (render_signature(sig))
        }
        @if let Some(file) = &doc.item_file {
            p.meta {
                "Defined in "
                code { (file)
                    @if let Some(line) = doc.item_line { ":" (line) }
                }
            }
        }
        @for name in &doc.ordered_sections {
            @if let Some(node) = doc.content.get(name) {
                @if !name.is_empty() && name != "Body" {
                    h2 { (name) }
                }
                (render_node(node))
            }
        }
    }
}

pub fn narrative_page(key: &str, doc: &GeneratedDoc) -> Markup {
    html! {
        @for name in &doc.ordered_sections {
            @if let Some(node) = doc.content.get(name) {
                (render_node(node))
            }
        }
        @if doc.ordered_sections.is_empty() {
            p.meta { "Empty narrative page: " (key) }
        }
    }
}

fn render_signature(sig: &Signature) -> Markup {
    html! {
        pre.signature {
            span.kw { (sig.kind) " " }
            span.name { (sig.target_name) } "("
            @for (i, p) in sig.parameters.iter().enumerate() {
                @if i > 0 { ", " }
                span.param {
                    (p.name)
                    @if let Some(a) = &p.annotation { ": " span.ann { (a) } }
                    @if let Some(d) = &p.default { " = " span.def { (d) } }
                }
            }
            ")"
            @if let Some(r) = &sig.return_annotation { " -> " span.ann { (r) } }
        }
    }
}

fn render_nodes(nodes: &[Node]) -> Markup {
    html! { @for n in nodes { (render_node(n)) } }
}

fn render_node(node: &Node) -> Markup {
    match node {
        Node::Text(s) => html! { (s) },
        Node::Paragraph(c) => html! { p { (render_nodes(c)) } },
        Node::Heading { depth, children } => match depth {
            1 => html! { h2 { (render_nodes(children)) } },
            2 => html! { h3 { (render_nodes(children)) } },
            3 => html! { h4 { (render_nodes(children)) } },
            _ => html! { h5 { (render_nodes(children)) } },
        },
        Node::Section { children, title, .. } => html! {
            section {
                @if let Some(t) = title.as_deref().filter(|s| !s.is_empty()) {
                    h3 { (t) }
                }
                (render_nodes(children))
            }
        },
        Node::InlineCode(v) => html! { code { (v) } },
        Node::Code { value, status } => html! {
            pre.code data-status=[status.as_deref()] { code { (value) } }
        },
        Node::Emphasis(c) => html! { em { (render_nodes(c)) } },
        Node::Strong(c) => html! { strong { (render_nodes(c)) } },
        Node::Link { children, url, title } => html! {
            a href=(url) title=[title.as_deref()] { (render_nodes(children)) }
        },
        Node::BulletList { ordered, start, children, .. } => {
            if *ordered {
                html! { ol start=(start) { (render_nodes(children)) } }
            } else {
                html! { ul { (render_nodes(children)) } }
            }
        }
        Node::ListItem { children, .. } => html! { li { (render_nodes(children)) } },
        Node::ThematicBreak => html! { hr; },
        Node::Directive { name, value, children } => html! {
            div.directive {
                span.directive-name { ".. " (name) " ::" }
                @if let Some(v) = value { pre { (v) } }
                (render_nodes(children))
            }
        },
        Node::Unknown { tag } => html! {
            span.unknown title={ "unknown IR tag " (tag) } { "[" (tag) "]" }
        },
    }
}
