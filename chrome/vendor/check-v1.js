/* CiteStamp citation health v1.6.5 — checked in your browser.
   Docs + live tool: https://citestamp.com/check
   Resolution is client-direct to OpenAlex, Crossref and DataCite, and to
   doi.org for a DOI none of them holds (registry mode: Crossref, DataCite
   and doi.org only); the only CiteStamp call is the public graph endpoint,
   with a bare identifier. Your bibliography never leaves this browser. */
(function () {
"use strict";
if (window.CiteStampCheck) { return; }

var VERSION = "1.6.5";
var OPENALEX = "https://api.openalex.org";
var CROSSREF = "https://api.crossref.org";
var DATACITE = "https://api.datacite.org";
var DOIORG = "https://doi.org";
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

// Two titles are the same title when they normalise alike, or alike once the
// spaces go: a PDF line break can turn "non-specific" into "nonspecific".
function sameTitle(a, b) {
  var na = normTitle(a);
  var nb = normTitle(b);
  if (na.length === 0 || nb.length === 0) { return false; }
  return na === nb || na.split(" ").join("") === nb.split(" ").join("");
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

// A record's title in the forms it gets cited: the main title, and the main
// title with its subtitle. Crossref and DataCite keep a subtitle apart from
// the title (10.1177/0956797610383437 is title "Power Posing", subtitle "Brief
// Nonverbal Displays Affect Neuroendocrine Levels and Risk Tolerance"), and a
// citation usually gives both. A subtitle the title already carries adds no form.
function titleForms(title, subtitle) {
  var forms = [];
  var t = String(title == null ? "" : title);
  if (t.length === 0) { return forms; }
  forms.push(t);
  var st = String(subtitle == null ? "" : subtitle);
  var ns = normTitle(st);
  if (ns.length > 0 && normTitle(t).indexOf(ns) < 0) { forms.push(t + ": " + st); }
  return forms;
}

// The title forms of a search candidate or a resolved work.
function formsOf(c) {
  return c ? titleForms(c.title || c.display_name || "", c.subtitle || null) : [];
}

// The best titleScore of a cited title against any form.
function scoreAmong(cited, forms) {
  var best = 0;
  for (var i = 0; i < forms.length; i++) {
    var s = titleScore(cited, forms[i]);
    if (s > best) { best = s; }
  }
  return best;
}

function sameAmong(cited, forms) {
  for (var i = 0; i < forms.length; i++) { if (sameTitle(cited, forms[i])) { return true; } }
  return false;
}

function containAmong(cited, forms) {
  var best = 0;
  for (var i = 0; i < forms.length; i++) {
    var c = titleContainment(cited, forms[i]);
    if (c > best) { best = c; }
  }
  return best;
}

// A record's main title and subtitle from DataCite's titles array: the main
// title is the first entry with no titleType, the subtitle the first entry
// typed Subtitle (an alternative or translated title is neither).
function dataciteTitles(a) {
  var ts = (a && a.titles) || [];
  var main = null;
  var sub = null;
  for (var i = 0; i < ts.length; i++) {
    var e = ts[i] || {};
    if (!e.title) { continue; }
    var tt = lower(e.titleType || "");
    if (!tt && main === null) { main = String(e.title); }
    else if (tt === "subtitle" && sub === null) { sub = String(e.title); }
  }
  if (main === null && ts[0] && ts[0].title) { main = String(ts[0].title); }
  return { title: main, subtitle: sub };
}

// The first subtitle of a Crossref record (an array of strings), or null.
function crossrefSubtitle(m) {
  return (m && m.subtitle && m.subtitle[0]) ? String(m.subtitle[0]) : null;
}

// ---- parsers --------------------------------------------------------------

// BibTeX scanner. No regex with backslashes: walk braces by hand. Returns
// refs [{key, doi, title, year, raw}]. Plain reference lines between or around
// the entries are read as a list (a .bib pasted with a few typed lines).
function parseBib(text) {
  var s = String(text == null ? "" : text);
  var refs = [];
  var i = 0;
  while (i < s.length) {
    var at = s.indexOf("@", i);
    if (at < 0) { break; }
    var brace = s.indexOf("{", at);
    if (brace < 0) { break; }
    pushPlainLines(refs, s.slice(i, at));
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
    i = end + 1;
    // @comment, @string and @preamble carry no reference
    var kind = lower(trimStr(s.slice(at + 1, brace)));
    if (kind === "comment" || kind === "string" || kind === "preamble") { continue; }
    // cite key = up to the first comma
    var comma = inner.indexOf(",");
    var key = comma >= 0 ? trimStr(inner.slice(0, comma)) : null;
    if (key === "") { key = null; }
    var doi = fieldValue(inner, "doi");
    if (doi) { doi = findDoi(doi) || lower(stripDoiPrefix(doi)); }
    if (!doi) { doi = findDoi(inner); }
    // an arXiv id anywhere in the entry is its identifier: read it before any
    // title search can settle on a later work that shares the title
    if (!doi) {
      var ax = bibArxivId(inner);
      if (ax) { doi = "10.48550/arxiv." + ax; }
    }
    var title = fieldValue(inner, "title");
    refs.push({ key: key, doi: doi || null, title: title || null, year: bibYear(inner), raw: trimStr(rawEntry).slice(0, 240) });
  }
  pushPlainLines(refs, s.slice(i));
  return refs;
}

// The arXiv id a BibTeX entry carries: in any field (journal = {arXiv preprint
// arXiv:1706.03762}, a url, a note), or as eprint with archivePrefix = {arXiv}.
function bibArxivId(inner) {
  var ax = arxivIdIn(inner);
  if (ax) { return ax; }
  var pre = lower(fieldValue(inner, "archiveprefix") || fieldValue(inner, "eprinttype") || "");
  if (pre !== "arxiv") { return null; }
  return arxivIdIn("arxiv:" + (fieldValue(inner, "eprint") || ""));
}

// The year a BibTeX entry cites: year = {2017}, or a biblatex date = {2017-06-12}.
function bibYear(inner) {
  var y = trimStr(fieldValue(inner, "year") || fieldValue(inner, "date") || "");
  return isYearAt(y, 0) ? parseInt(y.slice(0, 4), 10) : null;
}

// A heading line in a pasted reference list, never a reference itself.
function isHeaderLine(t) {
  var bare = lower(trimStr(t));
  if (bare.charAt(bare.length - 1) === ":") { bare = bare.slice(0, bare.length - 1); }
  return bare === "references" || bare === "bibliography" || bare === "works cited" || bare === "reference list";
}

// Text outside the BibTeX entries: reference lines are read as a list; blank
// lines, % comments and headings ("References", "My sources:") are not references.
function pushPlainLines(refs, text) {
  var lines = String(text == null ? "" : text).split(String.fromCharCode(10));
  var keep = [];
  for (var i = 0; i < lines.length; i++) {
    var t = trimStr(lines[i]);
    if (t.length === 0 || t.charAt(0) === "%" || isHeaderLine(t)) { continue; }
    if (t.charAt(t.length - 1) === ":" && t.split(" ").length <= 4) { continue; }
    keep.push(t);
  }
  if (keep.length === 0) { return; }
  var more = parseList(keep.join(String.fromCharCode(10)));
  for (var j = 0; j < more.length; j++) { refs.push(more[j]); }
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

// Vancouver (ICMJE) reference lines: "Polack FP, Thomas SJ, Kitchin N, et al.
// Safety and efficacy of ... vaccine. N Engl J Med. 2020;383(27):2603-2615."
// Each name is a surname, then its initials in capitals with no dots.
var NAME_PARTICLES = { van: 1, der: 1, den: 1, de: 1, von: 1, la: 1, le: 1, di: 1, da: 1, du: 1, del: 1, dos: 1, das: 1, ten: 1, ter: 1 };

function isInitials(w) {
  if (w.length < 1 || w.length > 4) { return false; }
  for (var i = 0; i < w.length; i++) {
    var c = w.charAt(i);
    if (c < "A" || c > "Z") { return false; }
  }
  return true;
}

function isSurnameWord(w) {
  if (NAME_PARTICLES[w]) { return true; }
  var c0 = w.charAt(0);
  if (w.length < 2 || c0 < "A" || c0 > "Z") { return false; }
  for (var i = 1; i < w.length; i++) {
    var c = w.charAt(i);
    var code = w.charCodeAt(i);
    var letter = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || code > 191;
    if (!letter && c !== "-" && c !== "'" && code !== 8217) { return false; }
  }
  return true;
}

// "Polack FP, Thomas SJ, Kitchin N, et al" or "Ioannidis JPA": a Vancouver author list.
function vancouverAuthors(seg) {
  if (seg.length === 0 || seg.length > 400) { return false; }
  var parts = seg.split(",");
  var names = 0;
  for (var i = 0; i < parts.length; i++) {
    var p = trimStr(parts[i]);
    if (lower(p) === "et al" && i === parts.length - 1 && names > 0) { continue; }
    var raw = p.split(" ");
    var w = [];
    for (var r = 0; r < raw.length; r++) { if (raw[r].length > 0) { w.push(raw[r]); } }
    if (w.length < 2 || w.length > 5 || !isInitials(w[w.length - 1])) { return false; }
    for (var j = 0; j < w.length - 1; j++) { if (!isSurnameWord(w[j])) { return false; } }
    names++;
  }
  return names > 0;
}

// The title of a Vancouver line: the sentence after the author list.
function vancouverTitle(line) {
  var s = stripListMarker(trimStr(line));
  var end = s.indexOf(". ");
  if (end < 0 || !vancouverAuthors(s.slice(0, end))) { return null; }
  var rest = s.slice(end + 2);
  // "In: Book title" after the authors names the container, not the cited item
  if (lower(rest.slice(0, 3)) === "in:") { return null; }
  var t = titleSpan(rest);
  if (t && startsLikeTitle(t) && contentTokens(t).length >= 2 && findDoi(t) === null) { return t; }
  return null;
}

// The year a formatted reference line cites: an APA "(YYYY", else the last
// free-standing year outside its DOI and links (Vancouver "2020;383", IEEE
// ", 1979,"). null when there is none.
function lineYear(s) {
  var y = citedYearIn(s);
  if (y) { return y; }
  var words = s.split(" ");
  var found = null;
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    var lw = lower(w);
    if (lw.indexOf("doi") >= 0 || lw.indexOf("http") >= 0 || lw.indexOf("/") >= 0 || lw.indexOf("arxiv") >= 0) { continue; }
    for (var k = 0; k + 4 <= w.length; k++) {
      if (isYearAt(w, k) && (k === 0 || !isDigit(w.charAt(k - 1))) &&
          (k + 4 === w.length || !isDigit(w.charAt(k + 4)))) {
        found = parseInt(w.slice(k, k + 4), 10);
        k += 3;
      }
    }
  }
  return found;
}

// allowVancouver: reference-list parsing only. The prose reader
// (referenceFromText) keeps to the quoted and APA rules, so a sentence such as
// "Dr X. Then we ..." is never read as an author list and a title.
// minQuoted: the content words a quoted span needs to count as a title (2
// when omitted). The prose reader asks for 3 when the line has no cited year:
// a sentence quoting a short phrase (the "Ten Commandments" honesty effect) is
// not citing a work titled that, and 1.6.4 matched it to a 2017 record of that
// title.
function extractTitle(line, allowVancouver, minQuoted) {
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
    if (contentTokens(quoted).length >= (minQuoted || 2)) { return quoted; }
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
  // 3) Vancouver: an author list of surnames and initials, then the title
  if (allowVancouver) { return vancouverTitle(s); }
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
// at least one line carries an APA-style (year) marker or opens with
// numbering ("[12]", "12. ") AND at least one non-empty line cannot be a
// reference start. Bare-DOI lists and bare-title lists carry neither, so they
// never reflow — the advertised line-per-ref inputs are untouched by
// construction.
//
// A line STARTS a new reference when it opens with numbering ("[12]" or
// "12. "), carries a (year) marker in its first 100 chars, or opens with the
// "Surname, I." author shape. A start only closes the previous reference
// when that reference looks FINISHED (ends with ".", a DOI, or a URL) — an
// author-list wrap ("Mishra, P., &" / "Koehler, M. J. (2006)...") therefore
// keeps joining. A line that is nothing but a DOI/URL is absorbed into a
// previous reference that lacks one. A line that wrapped at a hyphen joins
// the next with no space. A title-like line after a reference that already
// ends in its DOI or link is a reference of its own, not a continuation.
// Section headers ("References", "Bibliography") are dropped. Worst case two
// run-on references merge into one row with an honest verdict; nothing
// crashes and nothing is invented.

function hasYearParenIn(s) {
  var i = s.indexOf("(");
  while (i >= 0) {
    if (isYearAt(s, i + 1)) { return true; }
    if (s.slice(i, i + 6) === "(n.d.)") { return true; }
    i = s.indexOf("(", i + 1);
  }
  return false;
}

// "[12]" or "12. " at the start of a line: a numbered reference list.
function numberedStart(line) {
  if (line.charAt(0) === "[") {
    var j = 1;
    var bd = 0;
    while (j < line.length && isDigit(line.charAt(j))) { j++; bd++; }
    if (bd > 0 && line.charAt(j) === "]") { return true; }
  }
  var k = 0;
  var nd = 0;
  while (k < line.length && isDigit(line.charAt(k))) { k++; nd++; }
  return nd > 0 && nd <= 3 && line.charAt(k) === "." && line.charAt(k + 1) === " ";
}

function looksLikeRefStart(line) {
  if (numberedStart(line)) { return true; }
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

// The last token is a DOI or a link: the reference is finished.
function endsWithLink(s) {
  var t = trimStr(s);
  var sp = t.lastIndexOf(" ");
  var last = sp >= 0 ? t.slice(sp + 1) : t;
  return last.indexOf("http") === 0 || findDoi(last) !== null;
}

// Lines that trail a finished reference without being one (PubMed and web
// reference tails).
var TRAILERS = ["pmid", "pmcid", "epub", "available", "retrieved", "accessed", "cited", "[cited",
  "isbn", "issn", "published", "online", "doi", "arxiv", "url"];

function looksLikeOwnTitle(t) {
  if (!startsLikeTitle(t) || contentTokens(t).length < 2) { return false; }
  var lo = lower(t);
  for (var i = 0; i < TRAILERS.length; i++) { if (lo.indexOf(TRAILERS[i]) === 0) { return false; } }
  return true;
}

// A line that ends in a hyphen joins the next with no space. Between two
// lowercase letters the hyphen is the line-break's ("the-" + "ory",
// "jour-" + "nal.pmed") and goes; beside a digit or a capital it is the
// text's own ("S0140-" + "6736(97)11096-0") and stays.
function joinHyphen(cur, t) {
  var before = cur.charAt(cur.length - 2);
  var after = t.charAt(0);
  var lowerPair = before >= "a" && before <= "z" && after >= "a" && after <= "z";
  return lowerPair ? cur.slice(0, cur.length - 1) + t : cur + t;
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
    if (isHeaderLine(t)) { continue; }
    if (cur === "") { cur = t; continue; }
    if (cur.charAt(cur.length - 1) === "-" && cur.length >= 2 && !isSpace(cur.charAt(cur.length - 2))) {
      cur = joinHyphen(cur, t);
      continue;
    }
    var doiOnly = t.indexOf(" ") < 0 && findDoi(t) !== null;
    if (doiOnly && findDoi(cur) === null) { cur = cur + " " + t; continue; }
    if (looksLikeRefStart(t) && endsRefish(cur)) { flush(); cur = t; }
    else if (endsWithLink(cur) && looksLikeOwnTitle(t)) { flush(); cur = t; }
    else { cur = cur + " " + t; }
  }
  flush();
  return out;
}

function reflowIfWrapped(lines) {
  var anyMarker = false;
  var anyContinuation = false;
  for (var i = 0; i < lines.length; i++) {
    var t = trimStr(lines[i]);
    if (t.length === 0) { continue; }
    if (!anyMarker && (hasYearParenIn(t) || numberedStart(t))) { anyMarker = true; }
    if (!anyContinuation && !looksLikeRefStart(t)) { anyContinuation = true; }
  }
  return anyMarker && anyContinuation ? joinWrappedLines(lines) : lines;
}

function parseList(text) {
  var lines = String(text == null ? "" : text).split(String.fromCharCode(10));
  lines = reflowIfWrapped(lines);
  var refs = [];
  for (var i = 0; i < lines.length; i++) {
    var line = trimStr(lines[i]);
    if (line.length === 0) { continue; }
    var doi = findDoi(line);
    var title = extractTitle(line, true);
    // the cited year rides only on a formatted reference whose title was read;
    // a bare title line keeps no year (a year inside a title is not a citation)
    var year = title ? lineYear(line) : null;
    // a DOI line only carries a title when the extraction is confident (it
    // feeds the DOI-title cross-check); a bare line falls back to whole-line
    if (doi) { refs.push({ key: null, doi: doi, title: title, year: year, raw: line.slice(0, 240) }); }
    else { refs.push({ key: null, doi: null, title: title || line, year: year, raw: line.slice(0, 240) }); }
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
      var btitle = extractTitle(body, true);
      refs.push({ key: key, doi: bdoi || null, title: btitle || body, year: btitle ? lineYear(body) : null, raw: body.slice(0, 240) });
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

// ---- references inside running text (1.6.0) --------------------------------
// An assistant's answer is prose, not a reference list: a line is offered to
// referenceFromText, which says whether it IS a reference. Unlike parseList
// it never treats a whole line as a bare title, so a sentence of prose is not
// sent to a title search. A line is a reference when it carries a DOI, an
// arXiv id, or a title the APA / quoted-title rules can isolate (or the
// "Title (Authors, 2017)" shape assistants write).

// The arXiv id after "arxiv:" or an arxiv.org abs/pdf/html path, lowercased,
// any vN dropped: new style (2201.11903) or old style (hep-th/9901001; math.GT/0309136
// reads as math/0309136, since the subject class is not part of the id or its DOI).
function arxivIdIn(text) {
  var s = lower(text);
  var marks = ["arxiv.org/abs/", "arxiv.org/pdf/", "arxiv.org/html/", "arxiv:"];
  for (var m = 0; m < marks.length; m++) {
    var at = s.indexOf(marks[m]);
    while (at >= 0) {
      var j = at + marks[m].length;
      while (j < s.length && s.charAt(j) === " ") { j++; }
      var k = j;
      var d1 = 0;
      while (k < s.length && isDigit(s.charAt(k))) { k++; d1++; }
      if (d1 === 4 && s.charAt(k) === ".") {
        k++;
        var d2 = 0;
        while (k < s.length && isDigit(s.charAt(k))) { k++; d2++; }
        if (d2 === 4 || d2 === 5) { return s.slice(j, k); }
      }
      var old = oldArxivIdAt(s, j);
      if (old) { return old; }
      at = s.indexOf(marks[m], at + 1);
    }
  }
  return null;
}

// An old-style arXiv id starting at s[j] (s lowercased): an archive of letters and
// hyphens (hep-th, cond-mat, math), an optional two-letter subject class (.gt), a
// slash and exactly seven digits. Returned without the class. null otherwise.
function oldArxivIdAt(s, j) {
  var k = j;
  while (k < s.length && ((s.charAt(k) >= "a" && s.charAt(k) <= "z") || s.charAt(k) === "-")) { k++; }
  if (k - j < 2 || s.charAt(j) === "-") { return null; }
  var archive = s.slice(j, k);
  if (s.charAt(k) === "." && s.charAt(k + 3) === "/" &&
      s.charAt(k + 1) >= "a" && s.charAt(k + 1) <= "z" && s.charAt(k + 2) >= "a" && s.charAt(k + 2) <= "z") {
    k += 3;
  }
  if (s.charAt(k) !== "/") { return null; }
  var n0 = k + 1;
  var e = n0;
  while (e < s.length && isDigit(s.charAt(e))) { e++; }
  return e - n0 === 7 ? archive + "/" + s.slice(n0, e) : null;
}

// The cited year: the first "(YYYY" in the line. null when there is none.
function citedYearIn(s) {
  var at = s.indexOf("(");
  while (at >= 0) {
    if (isYearAt(s, at + 1)) { return parseInt(s.slice(at + 1, at + 5), 10); }
    at = s.indexOf("(", at + 1);
  }
  return null;
}

// Any space-like character (no-break and thin spaces arrive in rendered
// text) becomes a plain space before the scanners see it.
function plainSpaces(s) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    out += (c === 160 || c === 8199 || c === 8201 || c === 8202 || c === 8239) ? " " : s.charAt(i);
  }
  return out;
}

function startsLikeTitle(t) {
  var c0 = t.charAt(0);
  return isDigit(c0) || (c0 !== lower(c0)) || c0 === String.fromCharCode(34) ||
    c0 === String.fromCharCode(8220);
}

// "Attention Is All You Need (Vaswani et al., 2017)": a capitalised span,
// then a parenthetical that holds a comma and ends in a year. Returns
// { title, year } or null.
function titleBeforeAuthorYear(s) {
  var at = s.indexOf(" (");
  if (at < 8) { return null; }
  var close = s.indexOf(")", at);
  if (close < 0) { return null; }
  var inner = s.slice(at + 2, close);
  if (inner.indexOf(",") < 0 || inner.length > 120) { return null; }
  var tail = trimStr(inner.slice(inner.lastIndexOf(",") + 1));
  if (tail.length < 4 || !isYearAt(tail, 0)) { return null; }
  var t = trimStr(s.slice(0, at));
  while (t.length && ".,:;-".indexOf(t.charAt(t.length - 1)) >= 0) { t = trimStr(t.slice(0, t.length - 1)); }
  if (!startsLikeTitle(t) || contentTokens(t).length < 3 || t.indexOf(". ") >= 0) { return null; }
  return { title: t, year: parseInt(tail.slice(0, 4), 10) };
}

// A list marker typed as text ("- ", "* ", a bullet, "3. ", "3) ", "[3] ").
function stripListMarker(s) {
  var c0 = s.charAt(0);
  if ((c0 === "-" || c0 === "*" || c0 === String.fromCharCode(8226) || c0 === String.fromCharCode(8211)) && s.charAt(1) === " ") {
    return trimStr(s.slice(2));
  }
  var k = 0;
  var open = c0 === "[";
  if (open) { k = 1; }
  var d = 0;
  while (k < s.length && isDigit(s.charAt(k))) { k++; d++; }
  if (d > 0 && d <= 3) {
    var c = s.charAt(k);
    if ((open && c === "]") || (!open && (c === "." || c === ")"))) {
      if (s.charAt(k + 1) === " ") { return trimStr(s.slice(k + 2)); }
    }
  }
  return s;
}

function referenceFromText(text) {
  var s = stripListMarker(collapseSpaces(plainSpaces(String(text == null ? "" : text))));
  if (s.length < 8 || s.length > 600) { return null; }
  var doi = findDoi(s);
  if (!doi) {
    var ax = arxivIdIn(s);
    if (ax) { doi = "10.48550/arxiv." + ax; }
  }
  // A quoted span of two content words is a title only beside a cited year:
  // Cerullo (2015), "The problem with phi," is a reference; a sentence quoting
  // the "Ten Commandments" effect, with no "(YYYY" of its own, is not (1.6.5).
  var title = extractTitle(s, false, citedYearIn(s) ? 2 : 3);
  // "Smith et al. (2020) showed that ..." passes the APA rule with a
  // lowercase span; a cited title starts with a capital, a digit or a quote.
  if (title && !startsLikeTitle(title)) { title = null; }
  var year = title ? citedYearIn(s) : null;
  if (!title) {
    var ta = titleBeforeAuthorYear(s);
    if (ta) { title = ta.title; year = ta.year; }
  }
  if (!doi && !title) { return null; }
  return { key: null, doi: doi, title: title, year: year, raw: s.slice(0, 240) };
}

// A link in an answer. Only a doi.org link or an arxiv.org link carries an
// identifier this reads; any other publisher URL returns null (a DOI dug out
// of a publisher path can carry the path's tail). The link text becomes the
// cited title only when it reads like one, so the DOI-title cross-check runs
// on [Title](https://doi.org/...) and never on [Smith et al., 2020](...).
function referenceFromLink(href, text) {
  var h = String(href == null ? "" : href);
  try { h = decodeURIComponent(h); } catch (e) {}
  var cut = h.search("[?#]");
  if (cut > 0) { h = h.slice(0, cut); }
  var lo = lower(h);
  var doi = null;
  var hosts = ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "https://www.doi.org/"];
  for (var i = 0; i < hosts.length; i++) {
    if (lo.indexOf(hosts[i]) === 0) { doi = findDoi(h.slice(hosts[i].length)); break; }
  }
  if (!doi && (lo.indexOf("https://arxiv.org/") === 0 || lo.indexOf("https://www.arxiv.org/") === 0 ||
      lo.indexOf("http://arxiv.org/") === 0)) {
    var ax = arxivIdIn(lo);
    if (ax) { doi = "10.48550/arxiv." + ax; }
  }
  if (!doi) { return null; }
  var t = collapseSpaces(plainSpaces(String(text == null ? "" : text)));
  while (t.length && ".,:;".indexOf(t.charAt(t.length - 1)) >= 0) { t = trimStr(t.slice(0, t.length - 1)); }
  var lt = lower(t);
  var titleLike = t.length > 0 && t.length <= 300 && findDoi(t) === null &&
    lt.indexOf("http") !== 0 && lt.indexOf("arxiv") < 0 && lt.indexOf("et al") < 0 &&
    !isYearAt(t, t.length - 4) && contentTokens(t).length >= 4 && startsLikeTitle(t);
  return { key: null, doi: doi, title: titleLike ? t : null, year: null, raw: (t || h).slice(0, 240) };
}

// ---- network --------------------------------------------------------------

function getJson(url) {
  // a fetch that throws before it returns a promise (no network stack, a
  // blocked scheme) did not answer, like a rejected one (1.6.5)
  var p;
  try { p = fetch(url, { headers: { "Accept": "application/json" } }); } catch (e) { return Promise.resolve({ __status: 0 }); }
  return p.then(function (r) {
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

// Registry mode asks one more time after a non-answer, the way the server's
// check_reference does. In a browser a 429 often arrives without CORS headers
// and so reads as a network failure (status 0); both get the retry.
function patientGet(url) {
  return getJson(url).then(function (r) {
    if (!lookupFailed(r)) { return r; }
    return new Promise(function (done) { setTimeout(done, r && r.__status === 429 ? 1500 : 700); })
      .then(function () { return getJson(url); });
  });
}

// Crossref's polite pool answers list queries at 3 a second and 3 at once
// (x-rate-limit-limit / x-concurrency-limit on its own answers, read
// 2026-10-19). Registry mode runs many checks in a burst, so its title
// searches go through one gate: one at a time, CR_SEARCH_GAP_MS apart.
var CR_SEARCH_GAP_MS = 400;
var crSearchGate = Promise.resolve();
function gatedGet(url) {
  var run = crSearchGate.then(function () { return patientGet(url); });
  crSearchGate = run.then(function () {}, function () {}).then(function () {
    return new Promise(function (done) { setTimeout(done, CR_SEARCH_GAP_MS); });
  });
  return run;
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

function crossrefByDoi(doi, mailto, get) {
  // Crossref takes the raw doi in the path (literal slashes), not encoded.
  var url = CROSSREF + "/works/" + doi + "?mailto=" + encodeURIComponent(mailto);
  return (get || getJson)(url);
}

function crossrefSearch(title, mailto, get) {
  // Crossref bibliographic search: CORS-open, keyless, unmetered — the
  // fallback when OpenAlex title search is budget-limited. Same client-direct
  // contract: the title goes from the user's browser, never a CiteStamp server.
  // subtitle (1.6.5): a title field, read only to match a citation that gives
  // the title and subtitle together; no author or export fields
  var url = CROSSREF + "/works?query.bibliographic=" + encodeURIComponent(title) +
    "&rows=5&select=DOI,title,subtitle,issued&mailto=" + encodeURIComponent(mailto);
  return (get || getJson)(url);
}

// Registry mode: Crossref's bibliographic search inside one publication year,
// with the citation as written. For a title that also names a later letter or
// erratum, the bare-title search can rank the cited article outside its top
// 5; measured for check_reference 2026-10-17 on the 2020 NEJM vaccine article,
// which the citation inside its year put 5th.
function crossrefSearchInYear(query, year, mailto, get) {
  var url = CROSSREF + "/works?query.bibliographic=" + encodeURIComponent(query) +
    "&filter=from-pub-date:" + year + "-01-01,until-pub-date:" + year + "-12-31" +
    "&rows=10&select=DOI,title,subtitle,issued&mailto=" + encodeURIComponent(mailto);
  return (get || getJson)(url);
}

function dataciteByDoi(doi, get) {
  // DataCite registers DOIs for data + preprint repositories (Zenodo, Dryad,
  // figshare) that OpenAlex and Crossref often do not cover. Raw doi in path,
  // CORS-open. No mailto needed.
  var url = DATACITE + "/dois/" + doi;
  return (get || getJson)(url);
}

// DataCite title search (registry mode only): an exact-phrase query on the
// title field, narrowed to the cited year when there is one. Measured for
// check_reference 2026-10-17: without the year, the real "Attention Is All
// You Need" ranked outside DataCite's top 5. A double quote or a backslash
// in the title would break the phrase, so both become spaces.
function dataciteTitleSearch(title, year, get) {
  var t = "";
  var s = String(title == null ? "" : title);
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    t += (ch === String.fromCharCode(34) || ch === String.fromCharCode(92)) ? " " : ch;
  }
  var q = "titles.title:" + String.fromCharCode(34) + trimStr(t) + String.fromCharCode(34) +
    (year ? " AND publicationYear:" + year : "");
  // sort=relevance puts exact titles first (the default order is not relevance)
  var url = DATACITE + "/dois?page%5Bsize%5D=5&sort=relevance&fields%5Bdois%5D=doi,titles,publicationYear&query=" +
    encodeURIComponent(q);
  return (get || getJson)(url);
}

function graphFor(site, identifier) {
  var url = site + "/api/v1/graph/" + identifier.split("/").map(encodeURIComponent).join("/");
  return getJson(url);
}

// The DOI system's own registration-agency lookup. It answers for EVERY DOI
// agency (Crossref, DataCite, mEDRA, JaLC, CNKI, KISTI, Airiti, ISTIC, OP,
// EIDR ...), keyless and CORS-open; OpenAlex, Crossref and DataCite between
// them do not hold every registered DOI. Probed 2026-10-16: a registered DOI
// answers [{ DOI, RA: "JaLC" }], an unregistered one [{ DOI, status: "DOI
// does not exist" }], a malformed one status "Invalid DOI". Only those two
// statuses are read as unregistered; anything else did not answer.
// Returns { agency } | { unregistered: true } | { failed: true }.
function doiRegistration(doi, get) {
  var url = DOIORG + "/ra/" + doi.split("/").map(encodeURIComponent).join("/");
  return (get || getJson)(url).then(function (r) {
    var row = (r && r.__status === 200 && r.length) ? r[0] : null;
    if (!row) { return { failed: true }; }
    if (row.RA) { return { agency: String(row.RA) }; }
    var st = lower(row.status || "");
    if (st === "doi does not exist" || st === "invalid doi") { return { unregistered: true }; }
    return { failed: true };
  });
}

// ---- shaping --------------------------------------------------------------

function workFromOpenAlex(w) {
  if (!w || !w.id) { return null; }
  var doi = w.doi ? lower(stripDoiPrefix(w.doi)) : null;
  return {
    id: w.id,
    doi: doi,
    title: w.title || w.display_name || null,
    // OpenAlex records carry no subtitle; Crossref and DataCite candidates do
    subtitle: w.subtitle || null,
    year: w.publication_year || null,
    is_retracted: w.is_retracted === true
  };
}

function workFromDataCite(d, fallbackDoi) {
  if (!d || !d.attributes) { return null; }
  var a = d.attributes;
  var doi = a.doi ? lower(a.doi) : fallbackDoi;
  var dt = dataciteTitles(a);
  return {
    id: doi ? doiUrl(doi) : null,
    doi: doi || null,
    title: dt.title,
    subtitle: dt.subtitle,
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
      subtitle: crossrefSubtitle(it),
      display_name: title,
      publication_year: (it.issued && it.issued["date-parts"] && it.issued["date-parts"][0] && it.issued["date-parts"][0][0]) || null,
      is_retracted: false
    });
  }
  return out;
}

// The same candidate shape from a DataCite search answer (registry mode).
function candsFromDataCite(dc) {
  var out = [];
  if (!dc || dc.__status !== 200 || !dc.data || !dc.data.length) { return out; }
  for (var i = 0; i < dc.data.length; i++) {
    var a = (dc.data[i] && dc.data[i].attributes) || {};
    var doi = a.doi ? lower(a.doi) : null;
    var dt = dataciteTitles(a);
    var title = dt.title;
    if (!doi || !title) { continue; }
    var y = parseInt(String(a.publicationYear == null ? "" : a.publicationYear), 10);
    out.push({
      id: doiUrl(doi),
      doi: doi,
      title: title,
      subtitle: dt.subtitle,
      display_name: title,
      publication_year: isNaN(y) ? null : y,
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

// The ONE place a marking's wording lives (1.6.2): the /check row and watchlist, the Word
// and Docs panes, the extension and the Zotero plugin all render THESE strings, by the
// badge's rule (routes/citestamped.ts). "by the publisher" only when the publisher deposited
// the notice. A notice Retraction Watch deposited names nobody in the label, and the
// provenance line credits it; a marking with no source at all (a RETRACTED: title, a bare
// OpenAlex flag, a relation that names no depositor) names nobody, and markingOrigin says
// where it came from. An expression of concern is never "retracted".
var MARK_PHRASES = {
  retraction: "marked retracted", retration: "marked retracted", withdrawal: "withdrawn",
  removal: "removed", partial_retraction: "partially retracted",
  expression_of_concern: "flagged with an expression of concern"
};
var STATUS_EVENT_TYPES = {
  "marked-retracted": "retraction", "withdrawn": "withdrawal", "removed": "removal",
  "partially-retracted": "partial_retraction", "expression-of-concern": "expression_of_concern"
};
function markingLabel(type, source) {
  var phrase = MARK_PHRASES[lower(type || "")] || "marked retracted";
  return phrase + (lower(source || "") === "publisher" ? " by the publisher" : "") + " (best-effort)";
}
// A verdict's marking label (a marked verdict with no event is a retraction).
function markedLabel(v) {
  var pe = v && v.publisherEvent;
  return markingLabel((pe && pe.type) ? pe.type : "retraction", pe ? pe.source : null);
}
// A watchlist item's label from its stored status, or null for a status that is no marking.
function statusLabel(status, pe) {
  var t = STATUS_EVENT_TYPES[status];
  return t ? markingLabel(t, pe ? pe.source : null) : null;
}
// Where a marking that credits no one came from; "" when the provenance line already says.
function markingOrigin(v) {
  if (!v || v.retracted !== "marked" || provenanceLine(v.publisherEvent)) { return ""; }
  if (v.retractedVia === "openalex-flag") { return "Marking from OpenAlex's record of this work; no retraction notice was found on its Crossref record."; }
  if (v.retractedVia === "crossref-title") { return "Marking read from the title of this work's Crossref record; no retraction notice is linked to it."; }
  return "Retraction notice via Crossref; the record does not say who deposited it.";
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

// The reference's own DOI is what resolved (not a title search that found the
// work under another DOI).
function citedDoiResolved(v) {
  var via = v ? v.resolvedVia : null;
  return via === "openalex-doi" || via === "crossref-doi" || via === "datacite-doi" || via === "doi-registration";
}

// The DOI to write when a reference is exported: the one the reference cites
// when that DOI resolved, else the record's.
function exportDoi(v) {
  if (v && v.ref && v.ref.doi && citedDoiResolved(v)) { return lower(v.ref.doi); }
  return (v && v.work && v.work.doi) ? v.work.doi : null;
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
    nothingToCheck: false,
    doiAgency: null,
    doiUnregistered: false,
    refutations: 0,
    refutationSources: [],
    inGraph: false,
    graphEdges: 0,
    graphSigned: 0,
    graphInferred: 0,
    fredFailed: 0,
    fredSuccessful: 0,
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
  // registry mode: no OpenAlex call anywhere in this check (see the header)
  var reg = opts.registries === true;
  // registry mode reads every lookup with one patient retry; null = getJson
  var get = reg ? patientGet : null;
  var v = emptyVerdict(ref);
  // the graph answer already fetched for a DOI no open database had; a
  // registered DOI that settles as resolved reuses it rather than asking twice
  var unfoundGraph = null;

  function refutationsStep() {
    // The unattended monitor path (opts.noGraph) MUST NOT touch our graph
    // endpoint — polling it on a timer would build an IP -> {DOI set}
    // fingerprint on our own infrastructure. has-refutations is surfaced only
    // in an interactive, user-present check.
    if (opts.noGraph) { return Promise.resolve(); }
    var recordId = v.work && v.work.doi ? doiUrl(v.work.doi) : null;
    if (!recordId) { return Promise.resolve(); }
    // The DOI the reference cites, when that DOI is what resolved: signed edges
    // hang on the DOI people cite, and a database can answer for it under
    // another DOI of the same work (a Zenodo version under its concept record,
    // a publisher alias). The record's own DOI is asked only when the graph has
    // nothing under the cited one. v.work.doi stays the record's DOI (the
    // watchlist keys on it to meet the delta feed).
    var cited = ref.doi && citedDoiResolved(v) ? doiUrl(lower(ref.doi)) : null;
    var canonId = cited || recordId;
    var alt = cited && lower(cited) !== lower(recordId) ? recordId : null;
    var reuse = !!(unfoundGraph && ref.doi && lower(canonId) === lower(doiUrl(ref.doi)));
    if (reuse) { v.graphSigned = 0; v.graphInferred = 0; }
    var lookup = reuse ? Promise.resolve(unfoundGraph) : graphFor(site, canonId);
    return lookup.then(function (g) {
      if (alt && (!g || g.__status === 404 || !g.edges || g.edges.length === 0)) {
        canonId = alt;
        return graphFor(site, alt);
      }
      return g;
    }).then(function (g) {
      if (!g || g.__status === 404 || !g.edges) { return; }
      var target = g.id || canonId;
      var srcs = [];
      for (var i = 0; i < g.edges.length; i++) {
        var e = g.edges[i];
        if (e.tier === "asserted") { v.graphSigned++; } else { v.graphInferred++; }
        if (e.predicate === "refutes" && e.object === target && e.tier === "asserted") {
          srcs.push(e.attribution);
        }
        // Typed replication outcomes (FORRT Replication Database) ride the
        // inferred tier under their own attribution. Their counters stay
        // separate: they are never folded into the signed refutation count.
        if (e.object === target && e.attribution === "forrt-fred") {
          if (e.predicate === "refutes") { v.fredFailed++; }
          else if (e.predicate === "supports") { v.fredSuccessful++; }
        }
      }
      v.refutations = srcs.length;
      v.refutationSources = srcs;
    });
  }

  function retractionFromCrossref(doi) {
    return crossrefByDoi(doi, mailto, get).then(function (cr) {
      if (cr && cr.message) {
        // the same record carries the subtitle OpenAlex leaves out; the
        // DOI-title cross-check reads it (no extra call)
        var crDoi = cr.message.DOI ? lower(cr.message.DOI) : lower(doi);
        if (v.work && !v.work.subtitle && v.work.doi && lower(v.work.doi) === crDoi) {
          v.work.subtitle = crossrefSubtitle(cr.message);
        }
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
    // a registry-mode candidate carries the search it came from (src), so one
    // pass can settle over Crossref's and DataCite's answers together
    function viaFor(c) { return (c && c.src) || via; }
    // years between a candidate and the cited year (0 when either is unknown)
    function yearGap(c) {
      var py = c ? c.publication_year : null;
      return (ref.year && py) ? Math.abs(py - ref.year) : 0;
    }
    // Ties go to an EXACT title, then to the cited year: token overlap scores
    // "Is Attention All You Need?" (2025) as high as "Attention Is All You
    // Need" itself, and a 2025 re-deposit of a 2017 paper shares its title.
    var best = null;
    var bestScore = 0;
    var bestExact = false;
    var bestContain = null;
    var bestContainScore = 0;
    for (var i = 0; i < results.length; i++) {
      var cand = results[i];
      // a candidate's title alone, and with its subtitle (1.6.5)
      var candForms = formsOf(cand);
      var sc = scoreAmong(ref.title, candForms);
      var ex = sameAmong(ref.title, candForms);
      if (sc > 0 && (!best || (ex && !bestExact) ||
          (ex === bestExact && (sc > bestScore || (sc === bestScore && yearGap(cand) < yearGap(best)))))) {
        bestScore = sc; best = cand; bestExact = ex;
      }
      var cn = containAmong(ref.title, candForms);
      if (cn > bestContainScore) { bestContainScore = cn; bestContain = cand; }
    }
    var rounded = Math.round(bestScore * 100) / 100;
    if (rounded > v.matchScore) { v.matchScore = rounded; }
    var exact = bestExact;
    if (reg && strict) {
      // Registry mode reads EVERY exact-title candidate, not just the first:
      // exact twins are common (an NEJM letter reuses its article's title, a
      // preprint and its journal version share one), so the cited year picks
      // between them, and two that nothing tells apart stay "confirm".
      var exacts = [];
      for (var x = 0; x < results.length; x++) {
        if (sameAmong(ref.title, formsOf(results[x]))) { exacts.push(results[x]); }
      }
      if (exacts.length > 0) {
        var same = [];
        var undated = [];
        for (var y = 0; y < exacts.length; y++) {
          var py = exacts[y].publication_year;
          if (ref.year && py === ref.year) { same.push(exacts[y]); }
          else if (!py) { undated.push(exacts[y]); }
        }
        var pool2 = ref.year ? (same.length ? same : undated) : exacts;
        if (pool2.length === 0) {
          // the exact title, but only from another year
          var off = exacts[0];
          v.resolved = true;
          v.resolvedVia = viaFor(off);
          v.weakMatch = true;
          v.suggestion = null;
          v.work = workFromOpenAlex(off);
          v.notes.push("the cited title matches " + (v.work && v.work.doi ? v.work.doi : "a work") +
            ", published " + off.publication_year + ", but the citation says " + ref.year +
            " — confirm it is the work meant");
          return Promise.resolve();
        }
        if (pool2.length > 1) {
          // earliest first: an original preprint before its later re-deposits
          pool2.sort(function (a, b) { return (a.publication_year || 9999) - (b.publication_year || 9999); });
          var dois = [];
          for (var z = 0; z < pool2.length && z < 3; z++) {
            var zd = pool2[z].doi ? lower(stripDoiPrefix(pool2[z].doi)) : null;
            if (zd && dois.indexOf(zd) < 0) { dois.push(zd); }
          }
          if (dois.length > 1) {
            v.resolved = true;
            v.resolvedVia = viaFor(pool2[0]);
            v.weakMatch = true;
            v.suggestion = null;
            v.work = workFromOpenAlex(pool2[0]);
            v.notes.push("several works share this exact title (" + dois.join(", ") + ") — confirm which one is meant");
            return Promise.resolve();
          }
        }
        best = pool2[0];
        exact = true;
      } else {
        exact = false;
      }
    }
    // an exact title clears either gate (a hyphen a PDF line break removed can
    // leave token overlap under 0.7 for the very same title)
    if (best && (strict ? exact : (exact || bestScore >= 0.7))) {
      v.resolved = true;
      v.resolvedVia = viaFor(best);
      v.suggestion = null;
      v.work = workFromOpenAlex(best);
      // The title matches, but the record is from more than a year away from
      // the cited year (a re-deposit, a later edition, a namesake): confirm,
      // never a clean resolve, so it is not exported. Registry mode settles
      // years above, over every exact candidate.
      if (!reg && yearGap(best) > 1) {
        v.weakMatch = true;
        v.notes.push("the cited title matches " + (v.work && v.work.doi ? v.work.doi : "a work") +
          ", published " + best.publication_year + ", but the citation says " + ref.year +
          " — confirm it is the work meant");
        return Promise.resolve();
      }
      // Several works share this exact title and nothing in the citation tells
      // them apart (no cited year, or more than one from it): confirm, earliest
      // named first, never a clean resolve to whichever came first. The 2017
      // "Attention Is All You Need" sits among 2025 re-deposits of that title.
      if (!reg && bestExact) {
        var twins = [];
        var seen = {};
        for (var tw = 0; tw < results.length; tw++) {
          var tc = results[tw];
          var td = tc.doi ? lower(stripDoiPrefix(tc.doi)) : null;
          if (!td || seen[td] || yearGap(tc) !== yearGap(best)) { continue; }
          if (!sameAmong(ref.title, formsOf(tc))) { continue; }
          seen[td] = 1;
          twins.push(tc);
        }
        if (twins.length > 1) {
          twins.sort(function (x, y) { return (x.publication_year || 9999) - (y.publication_year || 9999); });
          var named = [];
          for (var tn = 0; tn < twins.length && tn < 3; tn++) {
            named.push(lower(stripDoiPrefix(twins[tn].doi)) + (twins[tn].publication_year ? " (" + twins[tn].publication_year + ")" : ""));
          }
          v.weakMatch = true;
          v.work = workFromOpenAlex(twins[0]);
          v.notes.push("several works share this exact title (" + named.join(", ") + ") — confirm which one is meant");
          return Promise.resolve();
        }
      }
      // A title of one or two content words is shared by many works, and with
      // no cited year nothing tells them apart: an exact match is confirm,
      // never a clean resolve (1.6.5; a quoted "Ten Commandments" in prose
      // matched a 2017 record of that title).
      if (!ref.year && contentTokens(ref.title).length <= 2) {
        v.weakMatch = true;
        v.notes.push("a title this short is shared by many works and the citation gives no year; confirm " +
          (v.work && v.work.doi ? v.work.doi : "the match") + " is the work meant");
        return Promise.resolve();
      }
      if (v.work && v.work.is_retracted) { v.retracted = "marked"; v.retractedVia = "openalex-flag"; }
      // a DataCite-found work has no Crossref record to read a notice from
      if (v.work && v.work.doi && viaFor(best) !== "datacite-title") { return retractionFromCrossref(v.work.doi); }
      return Promise.resolve();
    }
    // The two weak gates below found a CANDIDATE, not the work: its title does
    // not match the cited one. It goes in v.suggestion, which every renderer
    // prints as "closest match: ...", and v.work stays null, so no surface shows
    // it as the matched record and the graph step reads no replication or
    // refutation data off it (1.6.5; 1.6.4 printed an unrelated chapter under
    // "The problem with phi"). The verdict is unchanged: resolved + weak = confirm.
    function closestOnly(c) {
      var w = workFromOpenAlex(c);
      v.work = null;
      v.suggestion = w ? { title: w.title, year: w.year, doi: w.doi } : null;
    }
    if (best && bestScore >= (strict ? 0.5 : 0.4)) {
      v.resolved = true;
      v.resolvedVia = viaFor(best);
      v.weakMatch = true;
      closestOnly(best);
      v.notes.push("closest open match is weak — confirm this is the work you meant");
      return Promise.resolve();
    }
    if (bestContain && bestContainScore >= 1 && contentTokens(ref.title).length >= 2) {
      // Jaccard missed (long canonical), but ALL of the query's content
      // tokens are present in a candidate — a short title of a longer work.
      // Surface as WEAK/uncertain, never a clean resolve.
      v.resolved = true;
      v.resolvedVia = viaFor(bestContain);
      v.weakMatch = true;
      closestOnly(bestContain);
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

  // Title search: OpenAlex first, then the Crossref bibliographic fallback
  // under the stricter gates. Fills v when a gate clears and resolves to
  // which sources ANSWERED, so the caller can tell a search result from an
  // outage.
  function titleSearch() {
    if (reg) { return registryTitleSearch(); }
    return openalexSearch(ref.title, mailto).then(function (oa) {
      // an out-of-budget OpenAlex answers 429 OR 200 with an error body (no
      // results array). Neither is an empty result set — treat both as the
      // source not answering.
      var oaAnswered = !!(oa && oa.__status === 200 && oa.results);
      var settled = oaAnswered ? settleTitle(oa.results, "openalex-title", false) : null;
      if (settled) { return settled.then(function () { return { oaAnswered: true, crAnswered: false }; }); }
      // OpenAlex did not settle it (unavailable, or nothing cleared a gate)
      // — fall back to Crossref bibliographic search under stricter gates.
      return crossrefSearch(ref.title, mailto).then(function (cs) {
        var crAnswered = !!(cs && cs.__status === 200 && cs.message && cs.message.items);
        var answered = { oaAnswered: oaAnswered, crAnswered: crAnswered };
        var settled2 = crAnswered ? settleTitle(candsFromCrossref(cs), "crossref-title", true) : null;
        if (settled2) { return settled2.then(function () { return answered; }); }
        return answered;
      });
    });
  }

  // Registry-mode title search: Crossref's bibliographic search, then
  // DataCite's title search, under the strict exact-title gate. No OpenAlex
  // call. DataCite is skipped only when Crossref already holds an exact title
  // that does not contradict the cited year; otherwise both answers are
  // settled together (an arXiv preprint lives in DataCite, while Crossref's
  // top hit can be a different paper that happens to share its title).
  // Resolves to which sources ANSWERED, like titleSearch.
  function registryTitleSearch() {
    var wanted = normTitle(ref.title);
    function tag(cands, src) {
      for (var i = 0; i < cands.length; i++) { cands[i].src = src; }
      return cands;
    }
    // the cited title equals one of the candidate's title forms (1.6.5)
    function exactForm(c) {
      var fs = formsOf(c);
      for (var f = 0; f < fs.length; f++) {
        var n = normTitle(fs[f]);
        if (n.length > 0 && n === wanted) { return true; }
      }
      return false;
    }
    function settles(cands) {
      for (var i = 0; i < cands.length; i++) {
        var py = cands[i].publication_year;
        if (exactForm(cands[i]) && (!ref.year || !py || py === ref.year)) { return true; }
      }
      return false;
    }
    function hasExact(cands) {
      for (var i = 0; i < cands.length; i++) {
        if (exactForm(cands[i])) { return true; }
      }
      return false;
    }
    // the citation as written, minus links and identifiers: authors, year and
    // venue help Crossref's ranking
    function citationText() {
      var parts = String(ref.raw || ref.title || "").split(" ");
      var keep = [];
      for (var i = 0; i < parts.length; i++) {
        var lo = lower(parts[i]);
        if (lo.indexOf("http") === 0 || lo.indexOf("doi:") === 0 || lo.indexOf("arxiv:") === 0 || findDoi(parts[i]) !== null) { continue; }
        keep.push(parts[i]);
      }
      return trimStr(keep.join(" ")).slice(0, 500);
    }
    return crossrefSearch(ref.title, mailto, gatedGet).then(function (cs) {
      var crAnswered = !!(cs && cs.__status === 200 && cs.message && cs.message.items);
      var crCands = crAnswered ? tag(candsFromCrossref(cs), "crossref-title") : [];
      // the exact title, but not from the cited year: ask Crossref again
      // inside that year before reading it as a mismatch
      var inYear = (crAnswered && ref.year && hasExact(crCands) && !settles(crCands))
        ? crossrefSearchInYear(citationText(), ref.year, mailto, gatedGet).then(function (ys) {
            if (ys && ys.__status === 200 && ys.message && ys.message.items) {
              crCands = tag(candsFromCrossref(ys), "crossref-title").concat(crCands);
            }
          })
        : Promise.resolve();
      return inYear.then(function () {
        if (settles(crCands)) {
          var s1 = settleTitle(crCands, "crossref-title", true);
          return (s1 || Promise.resolve()).then(function () { return { oaAnswered: false, crAnswered: true, dcAnswered: false }; });
        }
        return dataciteTitleSearch(ref.title, ref.year, get).then(function (dc) {
          var dcAnswered = !!(dc && dc.__status === 200 && dc.data);
          var answered = { oaAnswered: false, crAnswered: crAnswered, dcAnswered: dcAnswered };
          var merged = crCands.concat(dcAnswered ? tag(candsFromDataCite(dc), "datacite-title") : []);
          var s2 = merged.length ? settleTitle(merged, "crossref-title", true) : null;
          return (s2 || Promise.resolve()).then(function () { return answered; });
        });
      });
    });
  }

  // Which title searches answered, as words: "OpenAlex or Crossref" in the
  // default mode, "Crossref or DataCite" in registry mode.
  function searchedNames(t) {
    var names = [];
    if (t.oaAnswered) { names.push("OpenAlex"); }
    if (t.crAnswered) { names.push("Crossref"); }
    if (t.dcAnswered) { names.push("DataCite"); }
    return names.join(" or ");
  }

  function anyAnswered(t) {
    return !!(t.oaAnswered || t.crAnswered || t.dcAnswered);
  }

  // OpenAlex, Crossref and DataCite all missed this DOI. That is not the DOI
  // system's answer: mEDRA, JaLC, CNKI, KISTI and the other agencies register
  // DOIs none of the three carries. doi.org decides, and only a DOI that NO
  // agency registered can earn the hard negative.
  function settleUnfoundDoi(reg) {
    var agency = reg.agency || null;
    var la = lower(agency || "");
    var agencyDown = !!agency && ((la === "crossref" && crDown) || (la === "datacite" && dcDown));
    if (reg.failed || agencyDown) {
      // Not known whether this DOI is registered, or registered where we
      // could not read it: a lookup that did not answer must never read as
      // does-not-resolve.
      v.unchecked = true;
      v.notes.push(agencyDown
        ? "this DOI is registered with " + agency + ", but " + agency + " did not answer, so its record could not be read"
        : "the DOI lookup services did not answer");
      return Promise.resolve();
    }
    if (agency) {
      // A registered DOI whose record none of our sources carries. Not a
      // negative, and not a clean resolve either: there is no record to
      // cross-check the cited title or a retraction against, so it counts as
      // uncertain, is never exported, and never enrols in a watchlist.
      v.resolved = true;
      v.resolvedVia = "doi-registration";
      v.weakMatch = true;
      v.doiAgency = agency;
      v.work = { id: doiUrl(lower(ref.doi)), doi: lower(ref.doi), title: null, year: null, is_retracted: false };
      v.notes.push("this DOI is registered with " + agency + ", but its record is not in the databases CiteStamp reads (" +
        (reg ? "Crossref, DataCite" : "OpenAlex, Crossref, DataCite") + ") — open the DOI to confirm it is the work you meant");
      return Promise.resolve();
    }
    // doi.org: no DOI agency has registered this DOI.
    v.doiUnregistered = true;
    var where = "not registered with any DOI agency (doi.org)";
    if (!ref.title) {
      // say "no title could be read", never "has no title": a line can carry a
      // title in a shape the parser does not read
      v.notes.push("this DOI is " + where + ", and no title could be read from the reference to search" +
        (reg ? " (checked " + new Date().toISOString().slice(0, 10) + ")" : ""));
      return Promise.resolve();
    }
    // A real paper cited with a mistyped DOI is the commonest slip of all:
    // search the cited title before giving the negative.
    var before = v.notes.length;
    return titleSearch().then(function (t) {
      if (v.resolved) {
        // the title found the work; the cited DOI is still wrong, so this is
        // never a clean resolve
        v.weakMatch = true;
        // (or the match is only a closest candidate, v.work null since 1.6.5:
        // never say the cited title "matches" it)
        if ((reg || !v.work) && v.notes.length > before) {
          // the title gate already said what matched (another year, several
          // twins, a weak match): lead with the DOI, do not repeat the match
          v.notes.splice(before, 0, "the cited DOI is " + where);
          return;
        }
        v.notes.push("the cited DOI is " + where + "; the cited title matches " +
          (v.work && v.work.doi ? v.work.doi : "a work in the open record") + " — check the DOI");
        return;
      }
      if (!anyAnswered(t)) {
        v.notes.push("this DOI is " + where + "; the title search did not answer, so no corrected DOI could be looked up" +
          " (checked " + new Date().toISOString().slice(0, 10) + ")");
      } else {
        v.notes.push("this DOI is " + where + ", and the cited title has no confident match in " + searchedNames(t) +
          " (checked " + new Date().toISOString().slice(0, 10) + ")");
        if (reg && !t.crAnswered) { v.notes.push("Crossref's search did not answer, so a corrected DOI there may have been missed"); }
        else if (reg && !t.dcAnswered) { v.notes.push("DataCite's search did not answer, so a corrected DOI there may have been missed"); }
      }
    });
  }

  var crDown = false;
  var dcDown = false;
  var resolveStep;
  if (ref.doi) {
    // Crossref, then DataCite, then (unless noGraph) our graph, then doi.org.
    // Registry mode starts here; the default mode asks OpenAlex first.
    var fromRegistries = function () {
      return crossrefByDoi(ref.doi, mailto, get).then(function (cr) {
        if (lookupFailed(cr)) { crDown = true; }
        if (cr && cr.__status === 200 && cr.message) {
          v.resolved = true;
          v.resolvedVia = "crossref-doi";
          var m = cr.message;
          v.work = {
            id: cr.message.DOI ? doiUrl(lower(cr.message.DOI)) : null,
            doi: cr.message.DOI ? lower(cr.message.DOI) : ref.doi,
            title: (m.title && m.title[0]) || null,
            subtitle: crossrefSubtitle(m),
            year: (m.issued && m.issued["date-parts"] && m.issued["date-parts"][0] && m.issued["date-parts"][0][0]) || null,
            is_retracted: false
          };
          var ev = crossrefPublisherEvent(m);
          if (ev) { applyPublisherEvent(v, ev); }
          else { v.retracted = "clear"; }
          return;
        }
        // Crossref missed (and OpenAlex, outside registry mode). Many data + preprint repositories
        // (Zenodo, Dryad, figshare) register their DOIs with DataCite instead,
        // and citation databases do not index them. Try DataCite before giving up.
        return dataciteByDoi(ref.doi, get).then(function (dc) {
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
            if (g) { unfoundGraph = g; }
            if (g && g.__status !== 404 && g.edges && g.edges.length > 0) {
              v.inGraph = true;
              v.graphEdges = g.edges.length;
              for (var gi = 0; gi < g.edges.length; gi++) {
                if (g.edges[gi].tier === "asserted") { v.graphSigned++; } else { v.graphInferred++; }
              }
              v.notes.push("not in the major open databases, but it is in the CiteStamp citation graph (" + g.edges.length + " recorded citation claim" + (g.edges.length === 1 ? "" : "s") + ", which can include unverified depositor-declared references)");
            }
            // Whether ANY DOI agency registered it decides the verdict. A
            // registry outage alone no longer gates it: doi.org answers for
            // every agency, and when doi.org itself does not answer the
            // verdict is unchecked, never does-not-resolve.
            return doiRegistration(ref.doi, get).then(settleUnfoundDoi);
          });
        });
      });
    };
    resolveStep = reg ? fromRegistries() : openalexByDoi(ref.doi, mailto).then(function (oa) {
      if (oa && oa.__status === 200 && oa.id) {
        v.resolved = true;
        v.resolvedVia = "openalex-doi";
        v.work = workFromOpenAlex(oa);
        if (v.work && v.work.is_retracted) { v.retracted = "marked"; v.retractedVia = "openalex-flag"; }
        // cross-check retraction via Crossref regardless (cheap, more coverage)
        return retractionFromCrossref(ref.doi);
      }
      // OpenAlex missed (404) or was budget-limited (429) — try Crossref
      return fromRegistries();
    });
  } else if (ref.title) {
    resolveStep = titleSearch().then(function (t) {
      if (v.resolved) { return; }
      if (!anyAnswered(t)) {
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
        if (reg) {
          // check_reference's wording: a title-only miss is "couldn't check"
          // on every surface that renders registry mode, never a negative
          v.notes.push("no DOI to look up, and no confident title match in " + searchedNames(t) +
            " (checked " + new Date().toISOString().slice(0, 10) + "); a title search can miss a real work");
          if (!t.crAnswered) { v.notes.push("Crossref's search did not answer for this check"); }
          else if (!t.dcAnswered) { v.notes.push("DataCite's search did not answer for this check"); }
        } else {
          v.notes.push("no DOI to check against, and no confident title match -- not verified");
          if (!t.oaAnswered || !t.crAnswered) {
            v.notes.push("only one title search source answered for this check");
          }
        }
      }
    });
  } else {
    // Nothing was looked up, so nothing may be concluded (1.6.1): never the
    // hard does-not-resolve verdict (a hard negative requires a DOI that no
    // agency registered), and never "unchecked" either, whose copy says "try
    // again" when no retry can help an entry with nothing to look up.
    resolveStep = Promise.resolve();
    v.nothingToCheck = true;
    v.notes.push("no DOI or title to check");
  }

  return resolveStep.then(function () {
    // DOI-title cross-check: a reference carrying BOTH a DOI that resolved
    // AND a cited title must agree with the resolved work's title — a real
    // title stapled to the wrong DOI is the most common fabricated-reference
    // shape, and the DOI path alone would wave it through. Zero extra network
    // calls: scored against the already-resolved metadata. The containment
    // escape keeps a short cited form of a longer canonical title unflagged.
    // Both checks read the title alone and the title with its subtitle (1.6.5:
    // Carney 2010 cited with its full title read as a mismatch against
    // Crossref's bare "Power Posing").
    if (v.resolved && ref.doi && ref.title && v.work && v.work.title) {
      var workForms = titleForms(v.work.title, v.work.subtitle);
      var agree = scoreAmong(ref.title, workForms);
      var shortForm = containAmong(ref.title, workForms) >= 1 && contentTokens(ref.title).length >= 2;
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
    // The check threw before it finished. Unless a hard negative was already
    // established (doi.org said no agency registered the DOI), it is a check
    // that did not finish: couldn't check, never "not found" and never "found"
    // (1.6.5: deriveStatus read an empty verdict as does-not-resolve, and a
    // record that threw after v.resolved was set read as a clean resolve).
    if (!v.doiUnregistered) {
      v.resolved = false;
      v.unchecked = true;
      v.notes.push("the check stopped on an error before it finished");
    }
    v.status = deriveStatus(v);
    return v;
  });
}

function deriveStatus(v) {
  if (!v.resolved) {
    if (v.unchecked) { return "unchecked"; }
    if (v.noMatch) { return "no-match"; }
    if (v.nothingToCheck) { return "nothing-to-check"; }
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
  // non-empty input lines, so a renderer can say "N lines read as M references"
  var lineCount = 0;
  var inLines = String(text == null ? "" : text).split(String.fromCharCode(10));
  for (var li = 0; li < inLines.length; li++) { if (trimStr(inLines[li]).length > 0) { lineCount++; } }
  var limit = opts.concurrency || 4;
  return pool(refs, limit, function (ref) { return checkOne(ref, opts); }).then(function (verdicts) {
    var counts = { resolved: 0, uncertain: 0, unresolved: 0, noMatch: 0, unchecked: 0, withRefutations: 0, withFailedReplications: 0, retracted: 0 };
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
      else if (!v.resolved && (v.noMatch || v.nothingToCheck)) { counts.noMatch++; }
      else if (v.weakMatch || v.titleMismatch) { counts.uncertain++; }
      else if (v.resolved) { counts.resolved++; }
      else { counts.unresolved++; }
      if (v.refutations > 0) { counts.withRefutations++; }
      if (v.fredFailed > 0) { counts.withFailedReplications++; }
      if (v.retracted === "marked") { counts.retracted++; }
    }
    return {
      version: VERSION,
      checkedAt: new Date().toISOString(),
      total: refs.length,
      lines: lineCount,
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
  provenanceLine: provenanceLine,
  markingLabel: markingLabel,
  markedLabel: markedLabel,
  statusLabel: statusLabel,
  markingOrigin: markingOrigin,
  referenceFromText: referenceFromText,
  referenceFromLink: referenceFromLink,
  exportDoi: exportDoi
};
})();
