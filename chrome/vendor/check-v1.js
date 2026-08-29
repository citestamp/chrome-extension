/* CiteStamp citation health v1.3.0 — checked in your browser.
   Docs + live tool: https://citestamp.com/check
   Resolution is client-direct to OpenAlex and Crossref; the only CiteStamp
   call is the public graph endpoint, with a bare identifier. Your
   bibliography never leaves this browser. */
(function () {
"use strict";
if (window.CiteStampCheck) { return; }

var VERSION = "1.3.0";
var OPENALEX = "https://api.openalex.org";
var CROSSREF = "https://api.crossref.org";
var DATACITE = "https://api.datacite.org";
var SITE = "https://citestamp.com";
var MAILTO = "info@citestamp.com";

// ---- tiny character helpers (no regex, no backslash) ----------------------

function isDigit(ch) { return ch >= "0" && ch <= "9"; }

function isSpace(ch) {
  return ch === " " || ch === String.fromCharCode(9) ||
    ch === String.fromCharCode(10) || ch === String.fromCharCode(13);
}

function trimStr(s) { return String(s == null ? "" : s).replace(/^[ ]+/, "").replace(/[ ]+$/, "").trim(); }

function lower(s) { return String(s == null ? "" : s).toLowerCase(); }

// ---- DOI handling ---------------------------------------------------------

// Strip a leading doi: or doi.org/ wrapper without using a backslash regex.
function stripDoiPrefix(s) {
  var t = trimStr(s);
  var lo = lower(t);
  if (lo.indexOf("doi:") === 0) { return trimStr(t.slice(4)); }
  var marks = ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/"];
  for (var i = 0; i < marks.length; i++) {
    if (lo.indexOf(marks[i]) === 0) { return trimStr(t.slice(marks[i].length)); }
  }
  return t;
}

// Find the first DOI inside a string: "10." then >=4 digits then "/" then a run.
function findDoi(text) {
  var s = stripDoiPrefix(text);
  var at = s.indexOf("10.");
  while (at >= 0) {
    var j = at + 3;
    var digits = 0;
    while (j < s.length && isDigit(s.charAt(j))) { j++; digits++; }
    if (digits >= 4 && j < s.length && s.charAt(j) === "/") {
      var k = j + 1;
      // parentheses are valid IN doIs (e.g. 10.1016/S0140-6736(97)11096-0),
      // so they are NOT terminators; stop only at clearly-non-doi chars.
      while (k < s.length && !isSpace(s.charAt(k)) && s.charAt(k) !== ";" &&
             s.charAt(k) !== "," && s.charAt(k) !== "}" && s.charAt(k) !== "<" &&
             s.charAt(k) !== ">" && s.charAt(k) !== String.fromCharCode(34)) { k++; }
      var doi = s.slice(at, k);
      // trim trailing prose punctuation; trim a trailing ")" only when the
      // doi has no "(" of its own (so a prose "(10.x/y)" loses the paren but
      // 10.../(97)11096-0 keeps it)
      var changed = true;
      while (changed && doi.length) {
        changed = false;
        var last = doi.charAt(doi.length - 1);
        if (last === "." || last === "," || last === ";") { doi = doi.slice(0, doi.length - 1); changed = true; }
        else if (last === ")" && doi.indexOf("(") < 0) { doi = doi.slice(0, doi.length - 1); changed = true; }
      }
      return lower(doi);
    }
    at = s.indexOf("10.", at + 1);
  }
  return null;
}

function doiUrl(doi) { return "https://doi.org/" + doi; }

// ---- title normalization + similarity -------------------------------------

function normTitle(t) {
  var s = lower(t);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) { out += ch; }
    else if (out.length > 0 && out.charAt(out.length - 1) !== " ") { out += " "; }
  }
  return trimStr(out);
}

function tokens(t) {
  var parts = normTitle(t).split(" ");
  var keep = [];
  for (var i = 0; i < parts.length; i++) { if (parts[i].length > 0) { keep.push(parts[i]); } }
  return keep;
}

// Function words carry no title meaning. Scientific titles share heavy filler
// ("the role of ... in cancer"), so a raw token Jaccard lets two papers that
// differ only in the ONE word that matters ("...p53..." vs "...BRCA1...")
// score above the strong threshold. Dropping stopwords keeps the signal on
// the content tokens — that is the phantom-citation moat.
var STOPWORDS = {
  a: 1, an: 1, and: 1, are: 1, as: 1, at: 1, be: 1, but: 1, by: 1, for: 1,
  from: 1, in: 1, into: 1, is: 1, it: 1, its: 1, of: 1, on: 1, or: 1, that: 1,
  the: 1, to: 1, was: 1, were: 1, with: 1, we: 1, our: 1, this: 1, these: 1
};

function contentTokens(t) {
  var all = tokens(t);
  var keep = [];
  for (var i = 0; i < all.length; i++) {
    if (!STOPWORDS[all[i]]) { keep.push(all[i]); }
  }
  // A title that is all function words falls back to the raw tokens so we
  // never score against an empty content set.
  return keep.length > 0 ? keep : all;
}

// Jaccard token overlap, 0..1, over content tokens. The phantom-citation
// signal lives here.
function titleScore(a, b) {
  var ta = contentTokens(a);
  var tb = contentTokens(b);
  if (ta.length === 0 || tb.length === 0) { return 0; }
  var setB = {};
  for (var i = 0; i < tb.length; i++) { setB[tb[i]] = 1; }
  var inter = 0;
  var seen = {};
  for (var j = 0; j < ta.length; j++) {
    if (setB[ta[j]] && !seen[ta[j]]) { inter++; seen[ta[j]] = 1; }
  }
  var uni = {};
  for (var k = 0; k < ta.length; k++) { uni[ta[k]] = 1; }
  for (var m = 0; m < tb.length; m++) { uni[tb[m]] = 1; }
  var uniN = 0;
  for (var key in uni) { if (uni.hasOwnProperty(key)) { uniN++; } }
  return uniN === 0 ? 0 : inter / uniN;
}

// DIRECTIONAL containment: the fraction of the QUERY's content tokens present
// in the candidate. 1.0 means every content word of the (short) query appears
// in the (longer) candidate — a short title of a longer work, which Jaccard
// under-scores. Directional, NOT min-symmetric: a long query is never rescued
// by a short unrelated candidate. Used ONLY to flag a WEAK/uncertain match
// (full containment into a longer work is "confirm this", never a clean "ok").
function titleContainment(query, cand) {
  var tq = contentTokens(query);
  var tc = contentTokens(cand);
  if (tq.length === 0 || tc.length === 0) { return 0; }
  var setC = {};
  for (var i = 0; i < tc.length; i++) { setC[tc[i]] = 1; }
  var inter = 0;
  var seen = {};
  for (var j = 0; j < tq.length; j++) {
    if (setC[tq[j]] && !seen[tq[j]]) { inter++; seen[tq[j]] = 1; }
  }
  return inter / tq.length;
}

// ---- parsers --------------------------------------------------------------

// BibTeX scanner. No regex with backslashes: walk braces by hand. Returns
// refs [{key, doi, title, raw}].
function parseBib(text) {
  var s = String(text == null ? "" : text);
  var refs = [];
  var i = 0;
  while (i < s.length) {
    var at = s.indexOf("@", i);
    if (at < 0) { break; }
    var brace = s.indexOf("{", at);
    if (brace < 0) { break; }
    // capture the whole {...} block with brace balancing
    var depth = 0;
    var end = brace;
    for (var p = brace; p < s.length; p++) {
      var ch = s.charAt(p);
      if (ch === "{") { depth++; }
      else if (ch === "}") { depth--; if (depth === 0) { end = p; break; } }
    }
    if (depth !== 0) { end = s.length - 1; }
    var inner = s.slice(brace + 1, end);
    var rawEntry = s.slice(at, end + 1);
    // cite key = up to the first comma
    var comma = inner.indexOf(",");
    var key = comma >= 0 ? trimStr(inner.slice(0, comma)) : null;
    if (key === "") { key = null; }
    var doi = fieldValue(inner, "doi");
    if (doi) { doi = findDoi(doi) || lower(stripDoiPrefix(doi)); }
    if (!doi) { doi = findDoi(inner); }
    var title = fieldValue(inner, "title");
    refs.push({ key: key, doi: doi || null, title: title || null, raw: trimStr(rawEntry).slice(0, 240) });
    i = end + 1;
  }
  return refs;
}

// Read a BibTeX field value (brace- or quote-delimited) for a field name.
function fieldValue(inner, field) {
  var lo = lower(inner);
  var f = lower(field);
  var from = 0;
  while (from < lo.length) {
    var idx = lo.indexOf(f, from);
    if (idx < 0) { return null; }
    // the match must be a field token: preceded by start/comma/space, then "="
    var before = idx === 0 ? "," : inner.charAt(idx - 1);
    var okBefore = before === "," || isSpace(before) || before === "{";
    var afterPos = idx + f.length;
    var q = afterPos;
    while (q < inner.length && isSpace(inner.charAt(q))) { q++; }
    if (okBefore && q < inner.length && inner.charAt(q) === "=") {
      q++;
      while (q < inner.length && isSpace(inner.charAt(q))) { q++; }
      if (q >= inner.length) { return null; }
      var open = inner.charAt(q);
      if (open === "{") {
        var depth = 0;
        for (var p = q; p < inner.length; p++) {
          var ch = inner.charAt(p);
          if (ch === "{") { depth++; }
          else if (ch === "}") { depth--; if (depth === 0) { return cleanField(inner.slice(q + 1, p)); } }
        }
        return cleanField(inner.slice(q + 1));
      }
      if (open === String.fromCharCode(34)) {
        var close = inner.indexOf(String.fromCharCode(34), q + 1);
        if (close > q) { return cleanField(inner.slice(q + 1, close)); }
        return cleanField(inner.slice(q + 1));
      }
      // bare value up to comma / newline
      var stop = q;
      while (stop < inner.length && inner.charAt(stop) !== "," &&
             inner.charAt(stop) !== String.fromCharCode(10)) { stop++; }
      return cleanField(inner.slice(q, stop));
    }
    from = idx + f.length;
  }
  return null;
}

function cleanField(v) {
  var s = String(v == null ? "" : v);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === "{" || ch === "}") { continue; }
    if (isSpace(ch)) { if (out.length > 0 && out.charAt(out.length - 1) !== " ") { out += " "; } }
    else { out += ch; }
  }
  return trimStr(out);
}

// ---- formatted-reference title extraction ----------------------------------
// The canonical AI-assistant paste is a formatted APA/MLA reference line
// ("Vaswani, A., Shazeer, N. (2017). Attention is all you need. Advances
// in..."). Searching the WHOLE line buries the title under author, year, and
// venue noise, so extract the title span conservatively: a quoted title first
// (MLA), else the sentence after a leading authors-plus-(year) segment (APA).
// Anything low-confidence returns null and the caller keeps the whole-line
// behavior — bare titles, bare DOIs, and BibTeX entries are untouched.

// four digits at i that read like a publication year
function isYearAt(s, i) {
  if (i + 4 > s.length) { return false; }
  for (var k = 0; k < 4; k++) { if (!isDigit(s.charAt(i + k))) { return false; } }
  var head = s.slice(i, i + 2);
  return head === "15" || head === "16" || head === "17" || head === "18" ||
    head === "19" || head === "20";
}

// Title span: up to the first sentence-ending period (dropped) or question /
// exclamation mark (kept — titles end in them). A period right after a dotted
// or single-letter token ("U.S.", an initial) is an abbreviation, not a
// sentence end.
function titleSpan(rest) {
  var out = "";
  var run = "";
  for (var i = 0; i < rest.length; i++) {
    var ch = rest.charAt(i);
    var nxt = i + 1 < rest.length ? rest.charAt(i + 1) : "";
    if (ch === "." && (nxt === "" || isSpace(nxt))) {
      if (run.length >= 2 && run.indexOf(".") < 0) { break; }
      out += ch; run += ch;
    } else if ((ch === "?" || ch === "!") && (nxt === "" || isSpace(nxt))) {
      out += ch;
      break;
    } else if (isSpace(ch)) { out += ch; run = ""; }
    else { out += ch; run += ch; }
  }
  return trimStr(out);
}

function extractTitle(line) {
  var s = String(line == null ? "" : line);
  // 1) quoted title (MLA): the first straight- or curly-quoted span
  var open = s.indexOf(String.fromCharCode(34));
  var close = open >= 0 ? s.indexOf(String.fromCharCode(34), open + 1) : -1;
  if (close < 0) {
    open = s.indexOf(String.fromCharCode(8220));
    close = open >= 0 ? s.indexOf(String.fromCharCode(8221), open + 1) : -1;
  }
  if (open >= 0 && close > open) {
    var quoted = trimStr(s.slice(open + 1, close));
    while (quoted.length && (quoted.charAt(quoted.length - 1) === "." || quoted.charAt(quoted.length - 1) === ",")) {
      quoted = trimStr(quoted.slice(0, quoted.length - 1));
    }
    if (contentTokens(quoted).length >= 2) { return quoted; }
  }
  // 2) APA: an authors segment, "(year).", then the title sentence
  var at = s.indexOf("(");
  while (at >= 0) {
    if (isYearAt(s, at + 1)) {
      var j = at + 5;
      // allow (1935a) and (2017, June 12)
      if (j < s.length && s.charAt(j) >= "a" && s.charAt(j) <= "z") { j++; }
      if (j < s.length && s.charAt(j) === ",") {
        var lim = j + 16;
        while (j < s.length && j < lim && s.charAt(j) !== ")") { j++; }
      }
      if (j < s.length && s.charAt(j) === ")") {
        var prefix = trimStr(s.slice(0, at));
        // the prefix must read like an author list, not a title that happens
        // to contain a parenthetical year
        var authorish = prefix.length > 0 && prefix.length <= 220 &&
          (prefix.indexOf(",") >= 0 || prefix.indexOf("&") >= 0 ||
           prefix.charAt(prefix.length - 1) === ".");
        if (authorish) {
          var k = j + 1;
          while (k < s.length && (s.charAt(k) === "." || s.charAt(k) === ":" || isSpace(s.charAt(k)))) { k++; }
          var t = titleSpan(s.slice(k));
          if (t && contentTokens(t).length >= 2 && findDoi(t) === null) { return t; }
        }
      }
    }
    at = s.indexOf("(", at + 1);
  }
  return null;
}

// Plain newline-separated list: each non-empty line is a DOI, a formatted
// reference line, or a bare title.
// ---- PDF-paste reflow ------------------------------------------------------
// A reference list copied out of a PDF arrives with hard line breaks MID-
// reference (hanging-indent wrap), and the line-per-ref rule shreds one
// citation into fragments (live-probed 2026-07-23: 6 refs became 19 garbage
// rows). The reflow stitches wrapped lines back into whole references.
//
// It ONLY activates when the paste smells like wrapped formatted references:
// at least one line carries an APA-style (year) marker AND at least one
// non-empty line cannot be a reference start. Bare-DOI lists and bare-title
// lists carry no year markers, so they never reflow — the advertised
// line-per-ref inputs are untouched by construction.
//
// A line STARTS a new reference when it opens with numbering ("[12]" or
// "12. "), carries a (year) marker in its first 100 chars, or opens with the
// "Surname, I." author shape. A start only closes the previous reference
// when that reference looks FINISHED (ends with ".", a DOI, or a URL) — an
// author-list wrap ("Mishra, P., &" / "Koehler, M. J. (2006)...") therefore
// keeps joining. A line that is nothing but a DOI/URL is absorbed into a
// previous reference that lacks one. Section headers ("References",
// "Bibliography") are dropped. Worst case two run-on references merge into
// one row with an honest verdict; nothing crashes and nothing is invented.

function hasYearParenIn(s) {
  var i = s.indexOf("(");
  while (i >= 0) {
    if (isYearAt(s, i + 1)) { return true; }
    if (s.slice(i, i + 6) === "(n.d.)") { return true; }
    i = s.indexOf("(", i + 1);
  }
  return false;
}

function looksLikeRefStart(line) {
  if (line.charAt(0) === "[") {
    var j = 1;
    var bd = 0;
    while (j < line.length && isDigit(line.charAt(j))) { j++; bd++; }
    if (bd > 0 && line.charAt(j) === "]") { return true; }
  }
  var k = 0;
  var nd = 0;
  while (k < line.length && isDigit(line.charAt(k))) { k++; nd++; }
  if (nd > 0 && nd <= 3 && line.charAt(k) === "." && line.charAt(k + 1) === " ") { return true; }
  if (hasYearParenIn(line.slice(0, 100))) { return true; }
  var c = line.indexOf(",");
  if (c > 0 && c <= 40) {
    var m = c + 1;
    while (m < line.length && line.charAt(m) === " ") { m++; }
    var ch = line.charAt(m);
    if (ch >= "A" && ch <= "Z" && line.charAt(m + 1) === ".") { return true; }
  }
  return false;
}

// A reference reads as FINISHED when it ends with a period, or its last
// token is a DOI or URL (APA webpage refs end with a bare link, no period).
function endsRefish(s) {
  var t = trimStr(s);
  if (t.length === 0) { return false; }
  if (t.charAt(t.length - 1) === ".") { return true; }
  var sp = t.lastIndexOf(" ");
  var last = sp >= 0 ? t.slice(sp + 1) : t;
  if (last.indexOf("http") === 0) { return true; }
  return findDoi(last) !== null;
}

function joinWrappedLines(lines) {
  var out = [];
  var cur = "";
  function flush() {
    var t = trimStr(cur);
    if (t.length > 0) { out.push(t); }
    cur = "";
  }
  for (var i = 0; i < lines.length; i++) {
    var t = trimStr(lines[i]);
    if (t.length === 0) { flush(); continue; }
    var bare = lower(t);
    if (bare.charAt(bare.length - 1) === ":") { bare = bare.slice(0, bare.length - 1); }
    if (bare === "references" || bare === "bibliography" || bare === "works cited" || bare === "reference list") { continue; }
    if (cur === "") { cur = t; continue; }
    var doiOnly = t.indexOf(" ") < 0 && findDoi(t) !== null;
    if (doiOnly && findDoi(cur) === null) { cur = cur + " " + t; continue; }
    if (looksLikeRefStart(t) && endsRefish(cur)) { flush(); cur = t; }
    else { cur = cur + " " + t; }
  }
  flush();
  return out;
}

function reflowIfWrapped(lines) {
  var anyYear = false;
  var anyContinuation = false;
  for (var i = 0; i < lines.length; i++) {
    var t = trimStr(lines[i]);
    if (t.length === 0) { continue; }
    if (!anyYear && hasYearParenIn(t)) { anyYear = true; }
    if (!anyContinuation && !looksLikeRefStart(t)) { anyContinuation = true; }
  }
  return anyYear && anyContinuation ? joinWrappedLines(lines) : lines;
}

function parseList(text) {
  var lines = String(text == null ? "" : text).split(String.fromCharCode(10));
  lines = reflowIfWrapped(lines);
  var refs = [];
  for (var i = 0; i < lines.length; i++) {
    var line = trimStr(lines[i]);
    if (line.length === 0) { continue; }
    var doi = findDoi(line);
    var title = extractTitle(line);
    // a DOI line only carries a title when the extraction is confident (it
    // feeds the DOI-title cross-check); a bare line falls back to whole-line
    if (doi) { refs.push({ key: null, doi: doi, title: title, raw: line.slice(0, 240) }); }
    else { refs.push({ key: null, doi: null, title: title || line, raw: line.slice(0, 240) }); }
  }
  return refs;
}

// Auto-detect: an "@" entry with a brace block reads as BibTeX, else a list.
// Collapse any run of whitespace to a single space, and trim.
function collapseSpaces(s) {
  var out = "";
  var prevSpace = false;
  var tight = ".,;:?!)";
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (isSpace(ch)) { if (!prevSpace) { out += " "; } prevSpace = true; }
    else {
      // A brace unwrapped to a space can leave "Title ." — drop the space
      // before closing punctuation so title extraction sees a clean sentence.
      if (prevSpace && tight.indexOf(ch) >= 0 && out.charAt(out.length - 1) === " ") {
        out = out.slice(0, out.length - 1);
      }
      out += ch; prevSpace = false;
    }
  }
  return trimStr(out);
}

// Strip LaTeX control sequences to plain text. A command word (backslash +
// letters, e.g. bibitem, newblock) is dropped; a formatting group like
// textit{X} keeps its inner X because the command word is removed and the
// braces below become spaces; escaped punctuation (backslash + non-letter,
// e.g. an escaped ampersand) keeps the punctuation. No regex (served-string
// rule): a character scanner, backslash = char 92.
function stripLatex(s) {
  var BS = String.fromCharCode(92);
  var t = String(s == null ? "" : s);
  var out = "";
  var i = 0;
  while (i < t.length) {
    var ch = t.charAt(i);
    if (ch === BS) {
      var j = i + 1;
      var letter = j < t.length &&
        ((t.charAt(j) >= "a" && t.charAt(j) <= "z") || (t.charAt(j) >= "A" && t.charAt(j) <= "Z"));
      if (letter) {
        while (j < t.length &&
          ((t.charAt(j) >= "a" && t.charAt(j) <= "z") || (t.charAt(j) >= "A" && t.charAt(j) <= "Z"))) { j++; }
        out += " ";
        i = j;
      } else if (j < t.length) {
        var pc = t.charAt(j);
        out += (pc === "{" || pc === "}") ? " " : pc;
        i = j + 1;
      } else { i = j; }
    } else if (ch === "{" || ch === "}") { out += " "; i++; }
    else { out += ch; i++; }
  }
  return collapseSpaces(out);
}

// LaTeX manual bibliography: begin{thebibliography}{N} then one bibitem{key}
// per reference, each optionally broken by newblock, ending at
// end{thebibliography}. Each bibitem starts ONE reference. Without this,
// parseList split every newblock onto its own line and read a 10-entry
// bibliography as 40-plus bogus "references" (the end marker itself got
// checked). Text before the first bibitem and from end onward is dropped.
function parseThebib(text) {
  var BS = String.fromCharCode(92);
  var marker = BS + "bibitem";
  var s = String(text == null ? "" : text);
  var refs = [];
  var start = s.indexOf(marker);
  while (start >= 0) {
    var next = s.indexOf(marker, start + marker.length);
    var chunk = s.slice(start, next < 0 ? s.length : next);
    var endAt = chunk.indexOf(BS + "end");
    if (endAt >= 0) { chunk = chunk.slice(0, endAt); }
    var p = marker.length;
    while (p < chunk.length && isSpace(chunk.charAt(p))) { p++; }
    if (chunk.charAt(p) === "[") { var rb = chunk.indexOf("]", p); if (rb >= 0) { p = rb + 1; } }
    while (p < chunk.length && isSpace(chunk.charAt(p))) { p++; }
    var key = null;
    if (chunk.charAt(p) === "{") {
      var kb = chunk.indexOf("}", p);
      if (kb >= 0) { key = trimStr(chunk.slice(p + 1, kb)); p = kb + 1; }
    }
    if (key === "") { key = null; }
    var body = stripLatex(chunk.slice(p));
    if (body.length > 0) {
      var bdoi = findDoi(body);
      var btitle = extractTitle(body);
      refs.push({ key: key, doi: bdoi || null, title: btitle || body, raw: body.slice(0, 240) });
    }
    start = next;
  }
  return refs;
}

function parseInput(text) {
  var s = String(text == null ? "" : text);
  // A bibitem marks a LaTeX manual bibliography; check it before BibTeX/list.
  if (s.indexOf(String.fromCharCode(92) + "bibitem") >= 0) { return parseThebib(s); }
  var at = s.indexOf("@");
  if (at >= 0 && s.indexOf("{", at) > at) { return parseBib(s); }
  return parseList(s);
}

// ---- network --------------------------------------------------------------

function getJson(url) {
  return fetch(url, { headers: { "Accept": "application/json" } }).then(function (r) {
    if (r.status === 429) { return { __status: 429 }; }
    if (r.status === 404) { return { __status: 404 }; }
    if (!r.ok) { return { __status: r.status }; }
    return r.json().then(function (j) { j.__status = 200; return j; });
  }).catch(function () { return { __status: 0 }; });
}

// A lookup that did not ANSWER: rate-limited, server error, network failure,
// or a blocking proxy. A 404 IS an answer ("not found"). Only definitive
// answers may feed a negative verdict — an unanswered lookup surfaces as
// unchecked, never as does-not-resolve.
function lookupFailed(r) {
  return !r || (r.__status !== 200 && r.__status !== 404);
}

function openalexByDoi(doi, mailto) {
  var url = OPENALEX + "/works/" + doiUrl(doi) +
    "?select=id,doi,title,display_name,publication_year,is_retracted&mailto=" + encodeURIComponent(mailto);
  return getJson(url);
}

function openalexSearch(title, mailto) {
  var url = OPENALEX + "/works?search=" + encodeURIComponent(title) +
    "&per_page=3&select=id,doi,title,display_name,publication_year,is_retracted&mailto=" + encodeURIComponent(mailto);
  return getJson(url);
}

function crossrefByDoi(doi, mailto) {
  // Crossref takes the raw doi in the path (literal slashes), not encoded.
  var url = CROSSREF + "/works/" + doi + "?mailto=" + encodeURIComponent(mailto);
  return getJson(url);
}

function crossrefSearch(title, mailto) {
  // Crossref bibliographic search: CORS-open, keyless, unmetered — the
  // fallback when OpenAlex title search is budget-limited. Same client-direct
  // contract: the title goes from the user's browser, never a CiteStamp server.
  var url = CROSSREF + "/works?query.bibliographic=" + encodeURIComponent(title) +
    "&rows=5&select=DOI,title,issued&mailto=" + encodeURIComponent(mailto);
  return getJson(url);
}

function dataciteByDoi(doi) {
  // DataCite registers DOIs for data + preprint repositories (Zenodo, Dryad,
  // figshare) that OpenAlex and Crossref often do not cover. Raw doi in path,
  // CORS-open. No mailto needed.
  var url = DATACITE + "/dois/" + doi;
  return getJson(url);
}

function graphFor(site, identifier) {
  var url = site + "/api/v1/graph/" + identifier.split("/").map(encodeURIComponent).join("/");
  return getJson(url);
}

// ---- shaping --------------------------------------------------------------

function workFromOpenAlex(w) {
  if (!w || !w.id) { return null; }
  var doi = w.doi ? lower(stripDoiPrefix(w.doi)) : null;
  return {
    id: w.id,
    doi: doi,
    title: w.title || w.display_name || null,
    year: w.publication_year || null,
    is_retracted: w.is_retracted === true
  };
}

function workFromDataCite(d, fallbackDoi) {
  if (!d || !d.attributes) { return null; }
  var a = d.attributes;
  var doi = a.doi ? lower(a.doi) : fallbackDoi;
  var title = (a.titles && a.titles[0] && a.titles[0].title) || null;
  return {
    id: doi ? doiUrl(doi) : null,
    doi: doi || null,
    title: title,
    year: a.publicationYear || null,
    is_retracted: false
  };
}

// Map Crossref bibliographic-search items into the OpenAlex-shaped candidates
// the title gates score. An item without a DOI or a title cannot back a
// verdict; skip it.
function candsFromCrossref(cr) {
  var out = [];
  if (!cr || cr.__status !== 200 || !cr.message || !cr.message.items) { return out; }
  var items = cr.message.items;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var title = (it.title && it.title[0]) || null;
    if (!it.DOI || !title) { continue; }
    out.push({
      id: doiUrl(lower(it.DOI)),
      doi: lower(it.DOI),
      title: title,
      display_name: title,
      publication_year: (it.issued && it.issued["date-parts"] && it.issued["date-parts"][0] && it.issued["date-parts"][0][0]) || null,
      is_retracted: false
    });
  }
  return out;
}

// Severe publisher-update classes (v1). MARKED = the paper is marked
// retracted/withdrawn/removed; the softer expression_of_concern is severe
// (surfaced) but is NOT a retraction, so it does not set retracted="marked".
// correction/erratum/new_version are deliberately excluded (benign churn).
var SEVERE_EVENTS = {
  retraction: 1, withdrawal: 1, removal: 1,
  expression_of_concern: 1, partial_retraction: 1, retration: 1
};
var MARKED_EVENTS = {
  retraction: 1, withdrawal: 1, removal: 1, partial_retraction: 1, retration: 1
};

// Crossref stamps each relation object with the provenance of the record. The
// live vocabulary is exactly two values, "publisher" and "retraction-watch"
// (probed against the API). Older stored events predate the field: absent means
// UNKNOWN, and an unknown source is never claimed as either one.
function relationSource(rel) {
  return (rel && rel.source) ? lower(rel.source) : null;
}

// Best-effort publisher retraction-class event from a Crossref record. Reads
// BOTH update-to AND updated-by and the full severe vocabulary. Returns
// { type, notice, via, source } or null. The source is read off the SAME
// relation object that matched; the title heuristic has no relation object at
// all, so it reports source: null.
//   update-to[i]  = a work THIS record updates -> this record IS the notice,
//                   so notice = this record's own DOI (Elsevier self-
//                   referential notices list themselves here).
//   updated-by[i] = the notice that updated THIS record -> notice = that DOI.
// Indexing only update-to (the old behavior) misses the retracted paper when
// the paper's own record carries updated-by and no update-to.
function crossrefPublisherEvent(msg) {
  if (!msg) { return null; }
  var self = msg.DOI ? lower(msg.DOI) : null;
  var ut = msg["update-to"] || [];
  for (var i = 0; i < ut.length; i++) {
    var t1 = lower((ut[i] && ut[i].type) || "");
    if (SEVERE_EVENTS[t1]) { return { type: t1, notice: self, via: "crossref-relation", source: relationSource(ut[i]) }; }
  }
  var ub = msg["updated-by"] || [];
  for (var j = 0; j < ub.length; j++) {
    var t2 = lower((ub[j] && ub[j].type) || "");
    if (SEVERE_EVENTS[t2]) {
      return { type: t2, notice: (ub[j] && ub[j].DOI) ? lower(ub[j].DOI) : null, via: "crossref-relation", source: relationSource(ub[j]) };
    }
  }
  var titles = msg.title || [];
  for (var k = 0; k < titles.length; k++) {
    if (lower(titles[k]).indexOf("retracted:") === 0) { return { type: "retraction", notice: self, via: "crossref-title", source: null }; }
  }
  return null;
}

// The ONE place the provenance wording lives. The /check page, the watchlist,
// the Word task pane, the extension popup and Overleaf all render THIS string,
// so the credit cannot drift between surfaces.
//   noun   <- the EVENT TYPE. An expression of concern is NOT a retraction, and
//             Retraction Watch's taxonomy rests on exactly that distinction.
//   credit <- the Crossref relation SOURCE. Vocabulary is exactly two values,
//             "publisher" and "retraction-watch" (probed live). An absent or
//             unrecognized source claims NOTHING and renders nothing.
function provenanceLine(pe) {
  var src = (pe && pe.source) ? lower(pe.source) : "";
  var credit;
  if (src === "retraction-watch") { credit = "record curated by Retraction Watch."; }
  else if (src === "publisher") { credit = "deposited by the publisher."; }
  else { return ""; }
  var t = (pe && pe.type) ? lower(pe.type) : "";
  var noun = (t === "expression_of_concern") ? "Expression of concern" : "Retraction notice";
  return noun + " via Crossref — " + credit;
}

// Fold a publisher event onto a verdict: always record publisherEvent{type,
// notice, source}; only the MARKED subset flips retracted to "marked". A soft
// class (expression_of_concern) leaves retracted as-is but still surfaces the
// event. A missing source stays null — readers must not infer "publisher".
function applyPublisherEvent(v, ev) {
  if (!ev) { return; }
  v.publisherEvent = { type: ev.type, notice: ev.notice || null, source: ev.source || null };
  if (MARKED_EVENTS[ev.type]) { v.retracted = "marked"; v.retractedVia = ev.via; }
}

function emptyVerdict(ref) {
  return {
    ref: ref,
    resolved: false,
    work: null,
    resolvedVia: null,
    weakMatch: false,
    matchScore: 0,
    titleMismatch: false,
    suggestion: null,
    unchecked: false,
    noMatch: false,
    refutations: 0,
    refutationSources: [],
    inGraph: false,
    graphEdges: 0,
    retracted: "unknown",
    retractedVia: null,
    publisherEvent: null,
    status: "does-not-resolve",
    notes: []
  };
}

// ---- the per-reference check ----------------------------------------------

function checkOne(ref, opts) {
  opts = opts || {};
  var site = opts.site || SITE;
  var mailto = opts.mailto || MAILTO;
  var v = emptyVerdict(ref);

  function refutationsStep() {
    // The unattended monitor path (opts.noGraph) MUST NOT touch our graph
    // endpoint — polling it on a timer would build an IP -> {DOI set}
    // fingerprint on our own infrastructure. has-refutations is surfaced only
    // in an interactive, user-present check.
    if (opts.noGraph) { return Promise.resolve(); }
    var canonId = v.work && v.work.doi ? doiUrl(v.work.doi) : null;
    if (!canonId) { return Promise.resolve(); }
    return graphFor(site, canonId).then(function (g) {
      if (!g || g.__status === 404 || !g.edges) { return; }
      var target = g.id || canonId;
      var srcs = [];
      for (var i = 0; i < g.edges.length; i++) {
        var e = g.edges[i];
        if (e.predicate === "refutes" && e.object === target && e.tier === "asserted") {
          srcs.push(e.attribution);
        }
      }
      v.refutations = srcs.length;
      v.refutationSources = srcs;
    });
  }

  function retractionFromCrossref(doi) {
    return crossrefByDoi(doi, mailto).then(function (cr) {
      if (cr && cr.message) {
        var ev = crossrefPublisherEvent(cr.message);
        if (ev) { applyPublisherEvent(v, ev); }
        else if (v.retracted !== "marked") { v.retracted = "clear"; }
      }
    });
  }

  // score one search source's candidate list against the cited title and
  // apply the acceptance gates. Fills v and returns a follow-up promise when
  // a gate clears; returns null when nothing was acceptable. strict mode
  // (the Crossref bibliographic fallback) only grants a clean resolve on
  // EXACT normalized-title equality and raises the weak floor to 0.5 — tuned
  // 2026-07-07 against live query.bibliographic relevance, which returns
  // high-token-overlap DIFFERENT works (probe: the query "Attention Is All
  // You Need" came back "Is Attention All You Need?" at token overlap 1.0).
  // The OpenAlex gates are unchanged.
  var suggestionScore = 0;
  function settleTitle(results, via, strict) {
    var best = null;
    var bestScore = 0;
    var bestContain = null;
    var bestContainScore = 0;
    for (var i = 0; i < results.length; i++) {
      var cand = results[i];
      var candTitle = cand.title || cand.display_name || "";
      var sc = titleScore(ref.title, candTitle);
      if (sc > bestScore) { bestScore = sc; best = cand; }
      var cn = titleContainment(ref.title, candTitle);
      if (cn > bestContainScore) { bestContainScore = cn; bestContain = cand; }
    }
    var rounded = Math.round(bestScore * 100) / 100;
    if (rounded > v.matchScore) { v.matchScore = rounded; }
    var exact = false;
    if (best) {
      var bn = normTitle(best.title || best.display_name || "");
      exact = bn.length > 0 && bn === normTitle(ref.title);
    }
    if (best && (strict ? exact : bestScore >= 0.7)) {
      v.resolved = true;
      v.resolvedVia = via;
      v.suggestion = null;
      v.work = workFromOpenAlex(best);
      if (v.work && v.work.is_retracted) { v.retracted = "marked"; v.retractedVia = "openalex-flag"; }
      if (v.work && v.work.doi) { return retractionFromCrossref(v.work.doi); }
      return Promise.resolve();
    }
    if (best && bestScore >= (strict ? 0.5 : 0.4)) {
      v.resolved = true;
      v.resolvedVia = via;
      v.weakMatch = true;
      v.suggestion = null;
      v.work = workFromOpenAlex(best);
      v.notes.push("closest open match is weak — confirm this is the work you meant");
      return Promise.resolve();
    }
    if (bestContain && bestContainScore >= 1 && contentTokens(ref.title).length >= 2) {
      // Jaccard missed (long canonical), but ALL of the query's content
      // tokens are present in a candidate — a short title of a longer work.
      // Surface as WEAK/uncertain, never a clean resolve.
      v.resolved = true;
      v.resolvedVia = via;
      v.weakMatch = true;
      v.suggestion = null;
      v.work = workFromOpenAlex(bestContain);
      v.matchScore = Math.round(bestContainScore * 100) / 100;
      v.notes.push("your title looks like a shorter form of a longer work — confirm this is the one you meant");
      return Promise.resolve();
    }
    // nothing cleared a gate — keep the closest candidate so a flag stays
    // actionable ("closest match: ..." in the renderers)
    if (best && bestScore > 0 && bestScore > suggestionScore) {
      var sug = workFromOpenAlex(best);
      if (sug) {
        suggestionScore = bestScore;
        v.suggestion = { title: sug.title, year: sug.year, doi: sug.doi };
      }
    }
    return null;
  }

  var crDown = false;
  var dcDown = false;
  var resolveStep;
  if (ref.doi) {
    resolveStep = openalexByDoi(ref.doi, mailto).then(function (oa) {
      if (oa && oa.__status === 200 && oa.id) {
        v.resolved = true;
        v.resolvedVia = "openalex-doi";
        v.work = workFromOpenAlex(oa);
        if (v.work && v.work.is_retracted) { v.retracted = "marked"; v.retractedVia = "openalex-flag"; }
        // cross-check retraction via Crossref regardless (cheap, more coverage)
        return retractionFromCrossref(ref.doi);
      }
      // OpenAlex missed (404) or was budget-limited (429) — try Crossref
      return crossrefByDoi(ref.doi, mailto).then(function (cr) {
        if (lookupFailed(cr)) { crDown = true; }
        if (cr && cr.__status === 200 && cr.message) {
          v.resolved = true;
          v.resolvedVia = "crossref-doi";
          var m = cr.message;
          v.work = {
            id: cr.message.DOI ? doiUrl(lower(cr.message.DOI)) : null,
            doi: cr.message.DOI ? lower(cr.message.DOI) : ref.doi,
            title: (m.title && m.title[0]) || null,
            year: (m.issued && m.issued["date-parts"] && m.issued["date-parts"][0] && m.issued["date-parts"][0][0]) || null,
            is_retracted: false
          };
          var ev = crossrefPublisherEvent(m);
          if (ev) { applyPublisherEvent(v, ev); }
          else { v.retracted = "clear"; }
          return;
        }
        // OpenAlex and Crossref both missed. Many data + preprint repositories
        // (Zenodo, Dryad, figshare) register their DOIs with DataCite instead,
        // and citation databases do not index them. Try DataCite before giving up.
        return dataciteByDoi(ref.doi).then(function (dc) {
          if (lookupFailed(dc)) { dcDown = true; }
          if (dc && dc.__status === 200 && dc.data) {
            v.resolved = true;
            v.resolvedVia = "datacite-doi";
            v.work = workFromDataCite(dc.data, ref.doi);
            v.notes.push("found via DataCite — this looks like a data or preprint repository deposit (for example Zenodo), which citation databases may not index");
            return;
          }
          // None of the open databases had it. Before reporting it as unfound,
          // check whether CiteStamp's own citation graph knows the identifier —
          // it may carry depositor-declared references the indexes do not. The
          // unattended monitor path (opts.noGraph) skips this: it must never
          // reach our origin. A watched DOI that once resolved will not fall to
          // this branch anyway; a newly-unresolvable one surfaces via status.
          return (opts.noGraph ? Promise.resolve(null) : graphFor(site, doiUrl(ref.doi))).then(function (g) {
            if (g && g.__status !== 404 && g.edges && g.edges.length > 0) {
              v.inGraph = true;
              v.graphEdges = g.edges.length;
              v.notes.push("not in the major open databases, but it is in the CiteStamp citation graph (" + g.edges.length + " recorded citation claim" + (g.edges.length === 1 ? "" : "s") + ", which can include unverified depositor-declared references)");
            } else if (crDown || dcDown) {
              // a DOI REGISTRY did not answer, so nothing definitive is known
              // about this DOI — a lookup outage must never read as
              // does-not-resolve. (An OpenAlex outage alone does not gate
              // this: Crossref and DataCite are the registries of record, and
              // when both answer "not found" the negative verdict stands.)
              v.unchecked = true;
              v.notes.push("the DOI lookup services did not answer");
            } else {
              v.notes.push("not found in OpenAlex, Crossref, DataCite, or the CiteStamp graph");
            }
          });
        });
      });
    });
  } else if (ref.title) {
    resolveStep = openalexSearch(ref.title, mailto).then(function (oa) {
      // an out-of-budget OpenAlex answers 429 OR 200 with an error body (no
      // results array). Neither is an empty result set — treat both as the
      // source not answering.
      var oaAnswered = !!(oa && oa.__status === 200 && oa.results);
      var settled = oaAnswered ? settleTitle(oa.results, "openalex-title", false) : null;
      if (settled) { return settled; }
      // OpenAlex did not settle it (unavailable, or nothing cleared a gate)
      // — fall back to Crossref bibliographic search under stricter gates.
      return crossrefSearch(ref.title, mailto).then(function (cs) {
        var crAnswered = !!(cs && cs.__status === 200 && cs.message && cs.message.items);
        var settled2 = crAnswered ? settleTitle(candsFromCrossref(cs), "crossref-title", true) : null;
        if (settled2) { return settled2; }
        if (!oaAnswered && !crAnswered) {
          // no search source ANSWERED — a lookup outage, not a missing work;
          // it must never read as does-not-resolve
          v.unchecked = true;
          v.notes.push("the title lookup services did not answer");
        } else {
          // A search source ANSWERED and nothing cleared a gate. That is a
          // search RESULT, not an outage — sharing the "unchecked" status let
          // a probable phantom hide behind "try again". Still never the hard
          // does-not-resolve verdict: title search has recall limits, so a
          // no-DOI reference reports a no-match, never "fake". (Status slug is
          // "no-match", not a "verified" variant — the Word pane's vocabulary
          // test bans that substring across its whole document.)
          v.noMatch = true;
          v.notes.push("no DOI to check against, and no confident title match -- not verified");
          if (!oaAnswered || !crAnswered) {
            v.notes.push("only one title search source answered for this check");
          }
        }
      });
    });
  } else {
    resolveStep = Promise.resolve();
    v.notes.push("no DOI or title to check");
  }

  return resolveStep.then(function () {
    // DOI-title cross-check: a reference carrying BOTH a DOI that resolved
    // AND a cited title must agree with the resolved work's title — a real
    // title stapled to the wrong DOI is the most common fabricated-reference
    // shape, and the DOI path alone would wave it through. Zero extra network
    // calls: scored against the already-resolved metadata. The containment
    // escape keeps a short cited form of a longer canonical title unflagged.
    if (v.resolved && ref.doi && ref.title && v.work && v.work.title) {
      var agree = titleScore(ref.title, v.work.title);
      var shortForm = titleContainment(ref.title, v.work.title) >= 1 && contentTokens(ref.title).length >= 2;
      if (agree < 0.4 && !shortForm) {
        v.titleMismatch = true;
        v.matchScore = Math.round(agree * 100) / 100;
      }
    }
    if (v.resolved) { return refutationsStep(); }
  }).then(function () {
    v.status = deriveStatus(v);
    return v;
  }).catch(function () {
    v.status = deriveStatus(v);
    return v;
  });
}

function deriveStatus(v) {
  if (!v.resolved) {
    if (v.unchecked) { return "unchecked"; }
    if (v.noMatch) { return "no-match"; }
    return "does-not-resolve";
  }
  if (v.retracted === "marked") { return "marked-retracted"; }
  if (v.refutations > 0) { return "has-refutations"; }
  if (v.titleMismatch) { return "doi-title-mismatch"; }
  if (v.weakMatch) { return "needs-attention"; }
  return "ok";
}

// ---- concurrency-limited bibliography check -------------------------------

function pool(items, limit, worker) {
  return new Promise(function (resolve) {
    var results = [];
    var idx = 0;
    var done = 0;
    var active = 0;
    if (items.length === 0) { resolve([]); return; }
    function pump() {
      while (active < limit && idx < items.length) {
        (function (i) {
          active++;
          worker(items[i], i).then(function (r) {
            results[i] = r;
          }).catch(function () {
            results[i] = null;
          }).then(function () {
            active--; done++;
            if (done === items.length) { resolve(results); } else { pump(); }
          });
        })(idx);
        idx++;
      }
    }
    pump();
  });
}

function checkBibliography(text, opts) {
  opts = opts || {};
  var refs = parseInput(text);
  var limit = opts.concurrency || 4;
  return pool(refs, limit, function (ref) { return checkOne(ref, opts); }).then(function (verdicts) {
    var counts = { resolved: 0, uncertain: 0, unresolved: 0, noMatch: 0, unchecked: 0, withRefutations: 0, retracted: 0 };
    for (var i = 0; i < verdicts.length; i++) {
      var v = verdicts[i];
      if (!v) { continue; }
      // A weak title match or a DOI-title disagreement resolves to a
      // candidate but is not a confirmed resolution — count it as uncertain,
      // not resolved, so the tally an author trusts does not fold phantom-ish
      // refs into "resolved". A lookup outage is its own bucket: it is NOT
      // evidence the reference does not resolve. A no-DOI title the sources
      // answered but did not match is its own bucket too — a result, not an
      // outage, and still not the hard "does not resolve".
      if (!v.resolved && v.unchecked) { counts.unchecked++; }
      else if (!v.resolved && v.noMatch) { counts.noMatch++; }
      else if (v.weakMatch || v.titleMismatch) { counts.uncertain++; }
      else if (v.resolved) { counts.resolved++; }
      else { counts.unresolved++; }
      if (v.refutations > 0) { counts.withRefutations++; }
      if (v.retracted === "marked") { counts.retracted++; }
    }
    return {
      version: VERSION,
      checkedAt: new Date().toISOString(),
      total: refs.length,
      counts: counts,
      verdicts: verdicts
    };
  });
}

window.CiteStampCheck = {
  version: VERSION,
  parseBib: parseBib,
  parseList: parseList,
  parseThebib: parseThebib,
  parseInput: parseInput,
  checkOne: checkOne,
  checkBibliography: checkBibliography,
  provenanceLine: provenanceLine
};
})();
