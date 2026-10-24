# CiteStamp browser extensions

Thin wrappers around the hosted service. The design rule for everything in
this directory: **one core, thin shells**. The embeddable cores are authored
once (`the served client scripts on citestamp.com`) and served from citestamp.com; the Chrome extension
ships **byte-identical vendored copies** of them (`chrome/vendor/`, see that
directory's README) because MV3 forbids remotely-hosted code. Extensions detect
context, fetch public data, and link back to citestamp.com, they do not
duplicate service logic.

## chrome/: Manifest V3

v1 is **read/lookup only**: on a DOI-bearing page the extension detects the
paper's identifier, shows an edge count on the toolbar badge, and the popup
renders the paper's citation record, human-signed and machine-inferred
claims kept strictly apart, same tier firewall as the site.

Data flow (every call the extension makes; the same list as https://citestamp.com/privacy):

- `content/detect.js` reads the page **locally** (meta tags, URL, links)
  to find a DOI. Nothing about the page leaves the browser.
- When a DOI is found, the service worker fetches that identifier's public
  record from `api.citestamp.com/api/v1/graph/<id>` (CORS-open, KV-cached,
  unauthenticated) and badges the tab with the edge count.
- The popup fetches the same public endpoint and renders it, with links to
  the paper page, graph view, and ORCID claim flow on citestamp.com.
- On an Overleaf project, the bibliography check sends each reference's DOI or
  title from your browser to Crossref, DataCite and OpenAlex, a DOI none of them
  holds to doi.org, and resolved identifiers to the public graph endpoint. The
  .bib file and the manuscript are never sent anywhere as a document.
- The Pro `@cite` picker searches Crossref and OpenAlex with what you type.
- The daily watchlist re-check asks Crossref, DataCite and OpenAlex directly and
  sends nothing about your list to CiteStamp. With a Pro key it instead
  downloads one shared file of publisher notices from api.citestamp.com, and the
  key is the only thing it sends. A Pro key also goes to api.citestamp.com to
  check your plan.
- On claude.ai and gemini.google.com it checks references only when you click
  for it: each DOI or title goes to Crossref, DataCite and doi.org, and a DOI
  that resolves also goes to the public graph endpoint.

No analytics, no history collection, **no remote code anywhere in the
package**, every core is vendored and loaded from disk. The detect/popup path
above makes no third-party requests at all: it talks only to
`api.citestamp.com`. The Overleaf writing surface does make client-direct
requests to OpenAlex, Crossref and DataCite (and doi.org for a DOI none of them
holds), because that is how a citation is
resolved without uploading your bibliography to us. The AI-chat check (below)
asks Crossref, DataCite and doi.org only.
Policy: https://citestamp.com/privacy

### AI chat answers (1.0.7): content/assistant.js

On claude.ai and gemini.google.com the popup offers **Check references on
this page**. Nothing runs on those sites until that click: the file is not a
declared content script, the popup injects `vendor/check-v1.js` +
`content/assistant.js` with `chrome.scripting.executeScript`, and the click is
what grants `activeTab`. No new permission, no `host_permissions`, no new
`content_scripts` match (a new match would disable the extension on update until
the user re-accepts).

- **Finding references** is the engine's job (`CiteStampCheck.referenceFromText`
  / `referenceFromLink`): a line is a reference when it carries a DOI, an arXiv
  id, or a title the APA / quoted-title / "Title (Authors, Year)" rules isolate;
  prose is never sent to a title search. Only doi.org and arxiv.org links are
  read as identifiers. The script reads `li, p, td, dd, blockquote` generically,
  skipping editable regions (the composer), code, nav, header, footer and forms,
  so it does not depend on either site's markup.
- **Registry mode** (`opts.registries`): Crossref, DataCite and doi.org, never
  OpenAlex (its keyless budget is per IP), the same chain as the server's
  `check_reference`. The user-asked check also reads the public graph for a
  resolving DOI (refutations, FORRT replication outcomes); the automatic path
  passes `noGraph:true` and never reaches a CiteStamp origin.
- **The automatic path** is bounded: the MutationObserver callback only re-arms a
  timer; a scan runs after 2.5 s of quiet (or 15 s of constant change), at most
  every 4 s; a reference is checked only when its line reads the same in two
  scans in a row; Claude's `data-is-streaming="true"` holds scans off; 100
  automatic checks per tab session, then it pauses. A new conversation (path
  change) clears the panel.
- **Verdicts** render in `check_reference`'s four words: found, confirm, not
  found, couldn't check. A hard negative needs a DOI that doi.org says no agency
  registered, and its line names where it looked and the date.
- The panel lives in a closed shadow root, built with `textContent` only (Gemini
  enforces Trusted Types; page text is untrusted).

### Architecture notes (for the next wrapper)

- `content/detect.js` is a self-guarding script: it defines
  `window.__csDetect()` once and its completion value is the detected DOI
  (or null), so the same file works both as a declared content script and
  as an on-demand `chrome.scripting.executeScript` injection from the
  popup ("Scan this page" on hosts outside the match list).
- Per-tab state lives in `chrome.storage.session` under `tab:<id>`;
  graph-count cache under `graph:<doi>`. The service worker owns writes;
  the popup only reads.
- Site-specific logic stays in `content/` as one file per concern, never
  forking `detect.js`.

## overleaf/: CodeMirror 6 cite picker (in chrome/content/overleaf.js)

The first **writing-surface** wrapper, and the first revenue surface for
"CiteStamp Write". On `overleaf.com/project/*` it gives you `@cite ` →
OpenAlex search → `\cite{key}` inserted at the cursor, with the matching
BibTeX entry copied to the clipboard to paste into your `.bib`.

- Runs in the **ISOLATED world** (no `world` key). It used to be `"world": "MAIN"`,
  solely so it could inject the hosted cores as remote `<script src=…>` tags under
  Overleaf's `strict-dynamic` CSP, remotely-hosted code, which MV3 forbids. The
  cores are now vendored and loaded by the manifest, so the MAIN world buys
  nothing, and the Pro token never enters the page's JS world.
- No `host_permissions`. Cross-origin `fetch` to OpenAlex/Crossref/DataCite works
  from the ISOLATED world because all three are CORS-open. `clipboardWrite` is
  declared for exactly one line: `execCommand("copy")` returns `false` from an
  ISOLATED content script without it.
- `content/overleaf.js` is **editor-binding glue only**, it builds a
  CodeMirror 6 adapter (the textarea adapter's sibling: same
  node/capture/before/replace/rect/focus contract) and hands it to
  `CiteStampPicker.attach`. Insertion goes through CM6's own
  `beforeinput`/`input` path via `execCommand("insertText")`, which dispatches a
  **trusted** event; a synthetic `InputEvent` is ignored by CM6 and must not be
  added back as a "fallback". All search, ranking, panel UI, staging and
  formatting stay in the one core.
- The `@cite ` picker is a **Pro** action (it writes into the manuscript). The
  gate is a client-side entitlement read through `CiteStampEntitlement`; it is
  not cryptographic and is not described as such.
- Staged claims are local-only, keyed by the Overleaf **project id**
  (`cs_staged:<project-id>`), never a user identity.
- Direct `.bib` file writes (vs. clipboard) are a follow-up pending a probe
  of Overleaf's internal file API against a real session.

It also carries the **citation-health** check, which is **free**, here and
everywhere. A floating "CiteStamp: check bibliography" button opens a panel where
you paste your `.bib` and run `CiteStampCheck.checkBibliography`. Parsing and
resolution happen in your browser; your draft never touches a CiteStamp server.
References that resolve then have their DOI looked up in the public citation
graph, which is how recorded refutations are surfaced. The panel lists only the
references that need attention: ones that don't resolve to a known work (the
AI-hallucination catch), have recorded refutations, or are marked retracted.

**Continuous checking** (`vendor/continuous-v1.js`) is the **Pro** surface: the
same engine, run without being asked. It reacts to what you type (cite keys on
the edited line) and what you paste (the clipboard payload). It is deliberately
**edit-scoped, never document-scoped**, CM6 virtualizes lines, and a measurement
against a real editor found only 67 of 2000 lines (2.9% of the characters)
present in the DOM, with the view object unreachable from a content script in
either world. "Read the document" is not an operation a content script has. That
constraint is also the cost guard: scrolling a 500-entry `.bib` must never cost a
lookup, because `checkOne` resolves OpenAlex first and OpenAlex is metered per IP.

The automatic path always passes `noGraph:true`, so it never touches a CiteStamp
origin, the price is that it cannot surface refutations, which stay in the
user-present manual check. Per-line inline gutter flags remain deferred, for the
same virtualization reason.

Free and Pro detect the same things. Pro buys automation, not sight.

- The same core also runs in the Word add-in and the Zotero plugin; a Google
  Docs add-on is next. Each is an adapter over the same core, never a fork of it.

### Loading unpacked

chrome://extensions → Developer mode → Load unpacked → `chrome` (this repository's folder).

The extension is live on the Chrome Web Store; shipping an update = build the
zip, then upload it in the CWS developer dashboard (review runs hours to a
day). Nothing in the build depends on the store.

### Icons

The mark is a document with a serif C pressed onto it as a rubber-stamp
impression, what the extension does: a claim stamped onto a paper. Two
raster masters, because the ink distress is a grunge texture that cannot be
a clean SVG, and because the document detail aliases away at toolbar sizes:

- `icons/icon-master.png` (512px), the full textured document + stamped C.
  Used for the large sizes.
- `icons/icon-master-small.png` (256px), a simplified document + bold C,
  no fine text lines. Used for 16/32 so the shape survives.

Regenerate the sized PNGs with:

    for s in 48 128; do magick icons/icon-master.png       -resize ${s}x${s} icons/icon$s.png; done
    for s in 16 32; do magick icons/icon-master-small.png  -resize ${s}x${s} icons/icon$s.png; done


## Source of truth

This repository mirrors the extension as published on the Chrome Web Store (https://chromewebstore.google.com/detail/citestamp/ibmggmbhdoofciggoakklidkgknmkjgi). Load `chrome/` unpacked to run it from source. `chrome/vendor/` holds copies of the client scripts served from citestamp.com, refreshed at each release. The service behind it (citestamp.com) is not open source; its signed log is: https://github.com/citestamp/op-log

## License

MIT, see LICENSE.
