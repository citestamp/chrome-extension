# Bundled cores (vendor/) — live

These files are the **hosted cores, vendored into the extension**, so the Chrome
MV3 listing can ship without remotely-hosted code. They are produced by
`extension/chrome/build-vendor.mjs` from the canonical source (the
`export const <NAME>_JS = \`…\`` template literal in each `the served client scripts on citestamp.com`)
and are **byte-identical** to what citestamp.com serves.

| file | global | source |
|---|---|---|
| `picker-v1.js` | `window.CiteStampPicker` | `https://citestamp.com/picker.js` |
| `check-v1.js` | `window.CiteStampCheck` | `https://citestamp.com/check.js` |
| `watchlist-v1.js` | `window.CiteStampWatchlist` | `https://citestamp.com/watchlist.js` |
| `entitlement-v1.js` | `window.CiteStampEntitlement` | `https://citestamp.com/entitlement.js` |
| `continuous-v1.js` | `window.CiteStampContinuous` | `https://citestamp.com/continuous.js` |

**Status: fully wired. There is no remotely-hosted code left in the extension.**

- `popup/popup.html` loads `entitlement-v1.js`, `check-v1.js`, `watchlist-v1.js`.
- The Overleaf content script loads `entitlement-v1.js`, `check-v1.js`,
  `picker-v1.js`, `continuous-v1.js` and then `content/overleaf.js` — all from
  the manifest's `content_scripts[].js` array, whose order **is** guaranteed
  within a single entry.

## Why the Overleaf script no longer runs in the MAIN world

It used to, for exactly one reason: it injected `citestamp.com/picker/v1.js` and
`/check/v1.js` into the page as `<script src=…>` tags, which Overleaf's
`strict-dynamic` CSP permits. That is remotely-hosted code — an MV3 violation
and a Chrome Web Store rejection trigger. Subresource Integrity does **not**
satisfy the policy (RHC is about provenance, not byte integrity).

The obvious fix was `web_accessible_resources` + `chrome.runtime.getURL()`, still
injecting into MAIN. It was never needed. Probed in a real Chromium against a
real CodeMirror 6, with a real unpacked extension:

- `execCommand("insertText")` from the ISOLATED world updates CM6's `state.doc`,
  not merely the DOM — the editor's document model syncs.
- A capture-phase `keydown` listener in the ISOLATED world fires **before** CM6's
  own handler, and `stopPropagation()` suppresses CM6's default.
- Cross-origin `fetch` to OpenAlex / Crossref / DataCite works from the ISOLATED
  world with **no `host_permissions`** (all three send `Access-Control-Allow-Origin: *`).
- A trusted `paste` is observable there, and `clipboardData` carries the complete
  payload.

So the cores load straight into the ISOLATED world, `world: "MAIN"` is gone,
`web_accessible_resources` is unnecessary, and the entitlement bridge that used
to shuttle a plan string across worlds is deleted. The Pro token now never enters
the page world, because there is no longer any extension code in it.

One thing the move did break, and the manifest now fixes: `execCommand("copy")`
returns `false` from an ISOLATED content script without the `clipboardWrite`
permission. It is declared for the BibTeX clipboard handoff, and for nothing else.

## What is deliberately NOT vendored

`https://citestamp.com/csl.js` (`/csl.js`, ~60 KB) — the CSL-JSON metadata normalizer and
five-style formatter behind `/check`'s export. `picker-js.ts` carries its own
self-contained `formatCitation`, and continuous checking renders **verdicts**,
not styled citations. Nothing in the extension imports it. Vendoring it would add
60 KB to the package and another review surface, and buy nothing.

## Refresh + drift check

```
node extension/chrome/build-vendor.mjs           # rewrite vendor/*.js from source
node extension/chrome/build-vendor.mjs --check   # exit 1 if vendor is stale
```

`--check` is in the test sweep. Run the writer again right before packing the
`.zip` for CWS. A change to a served core that does not regenerate these files is
a silent divergence between what the web loads and what the extension ships.

## Why only the extension bundles

Word (Office.js) and Google Docs (Apps Script) are not MV3 and may load remote
scripts, so they keep the hosted core and get instant updates. Only the extension
is frozen at package time.

Moving the engines server-side is not an option: they run client-direct so the
manuscript never touches a CiteStamp server, and so the OpenAlex per-IP budget is
spent on the user's own address rather than ours.

## SRI for Word / Google Docs (deferred — has prerequisites)

SRI on the hosted core defends only against a citestamp.com CDN/origin/transit
compromise (independent infra from the Google/Microsoft-served add-in HTML); it
does nothing against an add-in-project compromise or a malicious first-party
update. It is **not** free to adopt:

- `/picker/v1.js` is a **mutable** alias — pinning a hash to it means every core
  deploy breaks the hash and hard-fails the load. SRI needs **immutable,
  content-hashed URLs** (e.g. `/picker/<sha256>.js`) + a lockstep deploy that
  updates the `integrity=` attr in the add-in HTML atomically.
- **Disable all Cloudflare JS transforms** (Auto Minify, Rocket Loader) on the
  core's host, or they rewrite bytes post-build and break the hash.
- **Verify Apps Script HtmlService doesn't strip the `integrity` attribute**
  during its iframe-sandbox sanitization — if it does, SRI silently buys nothing
  for Google Docs.

Given citestamp.com already serves over HTTPS behind Cloudflare, this is a
narrow, optional hardening — do it only after the immutable-URL groundwork.
