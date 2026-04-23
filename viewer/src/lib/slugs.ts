// URL slug encoding for qualnames. Qualnames contain ':' (e.g.
// "papyri.gen:Config.__init__"), which is illegal on some filesystems and
// awkward in URLs. We encode using '$' as the separator because Python
// qualnames never contain '$', so round-trips are lossless.
//
// This module has NO Node.js imports so it is safe to use in both
// server-side code and browser bundles (e.g. React islands).

export function qualnameToSlug(qa: string): string {
  return qa.replace(/:/g, "$");
}

export function slugToQualname(slug: string): string {
  return slug.replace(/\$/g, ":");
}
