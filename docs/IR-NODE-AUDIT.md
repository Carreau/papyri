# IR node audit — what should not survive into a published bundle

This document reviews every node type registered in `papyri/nodes.py` and
identifies the ones that currently can reach disk but probably shouldn't.
Some are pure debug surfaces; others are intermediate placeholders that
the gen-time tree rewriter is supposed to consume but doesn't always.

The intent is to inform a phased cleanup, not to prescribe an immediate
breaking change. See "Suggested phased cleanup" at the end.

## Already correctly fenced off

These three are `UnserializableNode` and raise `NotImplementedError` if
anything tries to encode them. The contract works as designed:

- `GenToken`, `GenCode` (`nodes.py:625, 631`) — rewritten to `Code` by
  `tree.py:688 replace_GenCode`.
- `UnprocessedDirective` (`nodes.py:322`) — raises if it ever hits the
  encoder. **But** `tree.py:794` falls back to wrapping it in a
  *serializable* `Directive` when no handler matches. That fallback is
  the leak path that lets raw directives reach disk; see #1 below.

## Should NOT be in the final IR

### 1. `Directive` (raw / generic) — `nodes.py:309`

The "unknown directive" fallback. `tree.py:790-794` appends to
`_MISSING_DIRECTIVES`, logs `TODO: <name>`, and emits
`Directive.from_unprocessed(...)`. The viewer at `render-node.ts:214-221`
renders it as a generic `<aside class="directive directive-<name>">`
showing the directive's name as code — clearly a debug surface, not a
finished node.

Every `Directive` reaching disk means a directive `papyri gen` didn't
know how to translate. The IR contract should be:

- known directive → concrete node (`Admonition`, `Math`, `Code`,
  `Figure`, `BulletList` for toctree, ...)
- unknown directive → warn + drop, like `_SPHINX_ONLY_DIRECTIVES`
  already does at `tree.py:782-788`.

### 2. `Unimplemented` / `UnimplementedInline` — `nodes.py:218, 414`

Created in `ts.py` for: citations in odd positions (`ts.py:312`),
targets (`:680, :681`), attribution (`:686`), inline targets (`:691`),
footnotes (`:872`). The viewer renders them as `<span
class="unimplemented">` / `<div class="unimplemented">`
(`render-node.ts:263-272`). This is the inline equivalent of #1: a
debug surface masquerading as a node type. Their sibling class
`IntermediateNode` (see #4) literally states "should not make it to the
final Product".

### 3. `Comment` — `nodes.py:352`

Created at `ts.py:862` for every RST `..` comment line. Viewer renders
as the empty string (`render-node.ts:256-257: return "";`). If it
always renders to nothing it shouldn't be in the IR — drop in `ts.py`
instead. Today it wastes bytes on disk and adds noise to `papyri
describe` output.

### 4. `IntermediateNode` — `nodes.py:421`

Defined, has a docstring saying it should not make it to the final
product, and is referenced **zero** times anywhere in the repo. Pure
dead code. Delete it.

### 5. `Target` — `nodes.py:376`

CBOR-registered (tag 4061), and the viewer even has a renderer for it
(`render-node.ts:240-243`, emits `<span id="…">`), but **never
instantiated** in production code. RST targets that should yield this
node currently turn into `Unimplemented("target", …)` at
`ts.py:680-681`. Either wire it up properly (so `CrossRef` resolution
can target intra-document anchors) or delete the type. Today it's a
half-finished shape.

### 6. `SubstitutionDef` — `nodes.py:167`

`tree.py:677 replace_SubstitutionDef` always returns `[]`, so it never
reaches the encoder under normal flow. It's still in the type unions
for `Section.children`, `Root.children`, `DocParam.desc`. Since gen
always erases it, those union entries are stale; consider removing them
so the type system enforces the invariant.

### 7. `SubstitutionRef` — `nodes.py:179`

Should always be replaced by `tree.py:680 replace_SubstitutionRef`. If
one survives to disk, that's a bug (the handler logs a warning and
substitutes `Text`). Same situation as #6: the variant lingering in
`StaticPhrasingContent` is documentation of a transitional state, not a
real possibility post-`DirectiveVisiter`.

### 8. `UnprocessedDirective` in type unions

The class itself is correctly fenced (`UnserializableNode`), but it
still appears in `Section.children`, `ListItem.children`,
`DefListItem.dd`, `DocParam.desc`, and the `FlowContent` alias
(`nodes.py:305, 332, 540, 600, 749, 845`). After `DirectiveVisiter`
runs, none of these should hold an `UnprocessedDirective`. The unions
are dead variants — useful as transitional state during rewriting,
misleading on the final IR.

## Suggested phased cleanup (small PRs)

1. **Dead-code pass.** Delete `IntermediateNode`. Delete `Target` (or
   wire it up — but currently it's neither).
2. **Drop `Comment` at gen.** `ts.py:862` returns `[]` instead of
   `[Comment(...)]`. Remove the type and its viewer case.
3. **Tighten unknown-directive handling.** Make `tree.py:790-794` log +
   drop (matching the `_SPHINX_ONLY_DIRECTIVES` branch) instead of
   emitting a serializable `Directive`. Then either delete the
   `Directive` class or convert it to `UnserializableNode`. This is the
   biggest behaviour change — needs confirmation that no real bundle
   relies on it.
4. **Promote intermediates to `UnserializableNode`.** `Unimplemented`,
   `UnimplementedInline`, `SubstitutionDef`, `SubstitutionRef` (the
   last two are already always rewritten). Add a final post-rewrite
   pass in gen that walks the tree and asserts no intermediate
   survives — fail loudly instead of silently encoding placeholders.
5. **Trim type unions.** Remove now-unreachable variants from
   `Section.children`, `FlowContent`, `DocParam.desc`,
   `ListItem.children`, `DefListItem.dd`. `_invalidate`
   (`node_base.py:151`) will then enforce the contract at validate
   time.
