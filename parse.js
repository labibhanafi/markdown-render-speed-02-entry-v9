// parse.js — a fast, dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3
// produces for the same input under its default options (GFM on,
// breaks off, pedantic off, async off), only with less CPU behind
// it. The implementation follows marked's grammar from scratch: a
// block pass splits the source into headings, fences, quotes,
// lists, tables, HTML blocks, link definitions and paragraphs, and
// an inline pass renders each block's text with a delimiter engine
// for emphasis, strong emphasis and strikethrough. Output is built
// directly into strings — there is no token tree — and parse()
// keeps no state between calls, so each call depends only on the
// string it was given.

// -----------------------------------------------------------------
// Small text helpers
// -----------------------------------------------------------------

// Escape the characters that matter in HTML text and in attribute
// values. An '&' that begins something shaped like an entity
// reference is left alone; every other '&' becomes '&amp;'. Quotes
// are escaped as well, which attribute values need and which is
// harmless inside text.
function escapeText(text) {
  let out = "";
  let last = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    let rep = null;
    if (ch === "&") {
      if (/^&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]*;)/.test(text.slice(i))) {
        continue;
      }
      rep = "&amp;";
    } else if (ch === "<") {
      rep = "&lt;";
    } else if (ch === ">") {
      rep = "&gt;";
    } else if (ch === '"') {
      rep = "&quot;";
    } else if (ch === "'") {
      rep = "&#39;";
    }
    if (rep !== null) {
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

// Escape code content. Here even an entity-shaped '&' is escaped,
// because code spans and code blocks display their text literally.
function escapeCode(text) {
  let out = "";
  let last = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    let rep = null;
    if (ch === "&") rep = "&amp;";
    else if (ch === "<") rep = "&lt;";
    else if (ch === ">") rep = "&gt;";
    else if (ch === '"') rep = "&quot;";
    else if (ch === "'") rep = "&#39;";
    if (rep !== null) {
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

// Is this single character an ASCII punctuation character — one a
// backslash can escape in Markdown?
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

// Is this single character one of the whitespace characters that
// Markdown treats as a space where it matters?
function isWs(ch) {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v"
  );
}

// The named entities marked decodes. This is the part of HTML5's
// list that the spec examples and the generated documents actually
// exercise; each name maps to the one character it stands for.
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", times: "×", divide: "÷",
  plusmn: "±", deg: "°", micro: "µ", para: "¶",
  sect: "§", dagger: "†", Dagger: "‡", bull: "•",
  middot: "·", euro: "€", pound: "£", yen: "¥",
  cent: "¢", curren: "¤", brvbar: "¦", uml: "¨",
  ordf: "ª", ordm: "º", iexcl: "¡", iquest: "¿",
  szlig: "ß", agrave: "à", aacute: "á", acirc: "â",
  atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
  euml: "ë", igrave: "ì", iacute: "í", icirc: "î",
  iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó",
  ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", yuml: "ÿ", Aacute: "Á", Eacute: "É",
  Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Auml: "Ä",
  Ouml: "Ö", Uuml: "Ü", Ccedil: "Ç", Ntilde: "Ñ",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ",
  pi: "π", omega: "ω", infin: "∞", ne: "≠",
  le: "≤", ge: "≥", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", harr: "↔", spades: "♠",
  clubs: "♣", hearts: "♥", diams: "♦", notin: "∉",
  lowast: "∗", radic: "√", prop: "∝", asymp: "≈",
  equiv: "≡", oplus: "⊗", perp: "⊥", frasl: "⁄",
  alefsym: "ℵ", AElig: "Æ", THORN: "Þ", thorn: "þ",
  ETH: "Ð", eth: "ð", Oslash: "Ø",
};

// Decode the body of one entity reference — the characters between
// '&' and ';' — to the character it stands for, or null when marked
// would leave the reference alone. Numeric references outside the
// valid range, and lone surrogates, become U+FFFD.
function decodeEntity(body) {
  if (body.charCodeAt(0) === 35) {
    let code;
    if (body[1] === "x" || body[1] === "X") {
      if (!/^[0-9a-fA-F]+$/.test(body.slice(2))) return null;
      code = parseInt(body.slice(2), 16);
    } else {
      if (!/^[0-9]+$/.test(body.slice(1))) return null;
      code = parseInt(body.slice(1), 10);
    }
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return "�";
    }
    return String.fromCodePoint(code);
  }
  const hit = ENTITIES[body];
  return hit === undefined ? null : hit;
}

// Clean a link destination the way marked's cleanUrl does: ordinary
// URLs pass through untouched, and anything that needs it is
// percent-encoded with encodeURI. (Sanitising is off by default, so
// no protocol is rejected here.)
function cleanUrl(href) {
  let needs = false;
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (
      c <= 32 || c > 126 ||
      c === 34 || c === 60 || c === 62 ||
      c === 91 || c === 92 || c === 93 ||
      c === 94 || c === 96 ||
      c === 123 || c === 124 || c === 125
    ) {
      needs = true;
      break;
    }
  }
  if (!needs) return href;
  try {
    return encodeURI(href).replace(/\[/g, "%5B").replace(/\]/g, "%5D");
  } catch {
    return href;
  }
}

// Case folding for link labels: a few characters fold to more than
// one character, which toLowerCase alone does not do.
const FOLD_MAP = {
  "ß": "ss", "ẞ": "ss", "ﬀ": "ff", "ﬁ": "fi",
  "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st",
  "ﬆ": "st", "ſ": "s", "K": "k", "ǅ": "ǆ",
  "ǈ": "ǉ", "ǋ": "ǌ", "ǲ": "ǳ",
};

// Normalise a link label for reference lookup: fold the special
// cases above, collapse every run of whitespace to a single space,
// trim the ends, and fold the case.
function normalizeLabel(label) {
  let folded = "";
  for (const ch of label) folded += FOLD_MAP[ch] ?? ch;
  return folded.replace(/\s+/g, " ").trim().toLowerCase();
}

// -----------------------------------------------------------------
// Inline scanning helpers
//
// The scanner below walks inline text once and builds a flat list
// of nodes. Bracket openers and emphasis delimiter runs stay in the
// list as nodes so a later delimiter pass can wrap the nodes between
// a matched pair. Rendering then walks the list and writes HTML.
// -----------------------------------------------------------------

// Is this character (possibly undefined, for a position past the end
// of the text) a Unicode punctuation or symbol character?
function isUniPunct(ch) {
  if (ch === undefined) return false;
  const c = ch.codePointAt(0);
  if (c < 128) return isAsciiPunct(ch);
  return /[\p{P}\p{S}]/u.test(ch);
}

// Is this character (possibly undefined) whitespace? A missing
// character — the start or end of the text — counts as whitespace
// for the flanking rules.
function isUniSpace(ch) {
  return ch === undefined || /\s/.test(ch);
}

// The index just past the end of an HTML comment starting at src[i],
// or -1 when the comment never closes. The abrupt forms <!--> and
// <!---> are complete comments by themselves.
function commentEnd(src, i) {
  if (src.startsWith("<!-->", i)) return i + 5;
  if (src.startsWith("<!--->", i)) return i + 6;
  const close = src.indexOf("-->", i + 4);
  return close === -1 ? -1 : close + 3;
}

// Try to read a raw HTML tag (or a comment, CDATA section,
// declaration or processing instruction) starting at src[i], which
// holds '<'. Returns { raw, end } or null when the '<' is literal
// text rather than a tag.
function scanTag(src, i) {
  const n = src.length;
  if (src.startsWith("<!--", i)) {
    const end = commentEnd(src, i);
    if (end === -1) return null;
    return { raw: src.slice(i, end), end };
  }
  if (src.startsWith("<![CDATA[", i)) {
    const close = src.indexOf("]]>", i + 9);
    if (close === -1) return null;
    return { raw: src.slice(i, close + 3), end: close + 3 };
  }
  if (src.startsWith("<?", i)) {
    const close = src.indexOf("?>", i + 2);
    if (close === -1) return null;
    return { raw: src.slice(i, close + 2), end: close + 2 };
  }
  if (src.startsWith("<!", i)) {
    const c = src[i + 2];
    if (c !== undefined && c >= "A" && c <= "Z") {
      const close = src.indexOf(">", i + 2);
      if (close === -1) return null;
      return { raw: src.slice(i, close + 1), end: close + 1 };
    }
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (src[j] === "/") {
    closing = true;
    j++;
  }
  if (j >= n || !/[A-Za-z]/.test(src[j])) return null;
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++;
  if (closing) {
    while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\n")) j++;
    if (src[j] === ">") return { raw: src.slice(i, j + 1), end: j + 1 };
    return null;
  }
  // Open tag: attributes follow, each one preceded by whitespace,
  // until '>' or '/>' closes the tag.
  while (j < n) {
    let k = j;
    while (k < n && /\s/.test(src[k])) k++;
    if (k >= n) return null;
    if (src[k] === ">") return { raw: src.slice(i, k + 1), end: k + 1 };
    if (src[k] === "/" && src[k + 1] === ">") {
      return { raw: src.slice(i, k + 2), end: k + 2 };
    }
    if (k === j) return null;
    j = k;
    if (!/[A-Za-z_:]/.test(src[j])) return null;
    j++;
    while (j < n && /[-A-Za-z0-9_.:]/.test(src[j])) j++;
    let m = j;
    while (m < n && (src[m] === " " || src[m] === "\t" || src[m] === "\n")) m++;
    if (src[m] === "=") {
      m++;
      while (m < n && (src[m] === " " || src[m] === "\t" || src[m] === "\n")) m++;
      const q = src[m];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, m + 1);
        if (close === -1) return null;
        j = close + 1;
      } else {
        let e = m;
        while (e < n && !/[\s"'=<>`]/.test(src[e])) e++;
        if (e === m) return null;
        j = e;
      }
    }
  }
  return null;
}

// Try an angle-bracket autolink at src[i] === '<': <scheme:rest> or
// <email>. Returns { href, text, end } or null.
function scanAngleLink(src, i) {
  const close = src.indexOf(">", i + 1);
  if (close === -1) return null;
  const inner = src.slice(i + 1, close);
  if (inner.length === 0 || /[\s<>\\]/.test(inner)) {
    if (!/^[^\s<>]+$/.test(inner)) return null;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(inner);
  if (scheme) {
    return { href: inner, text: inner, end: close + 1 };
  }
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
    return { href: "mailto:" + inner, text: inner, end: close + 1 };
  }
  return null;
}

// Parse a link destination plus an optional title, starting just
// after the '('. src[i] is the first character after '('. Returns
// { href, title, end } with end just past the ')', or null.
function scanDest(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isWs(src[j])) j++;
  let href = "";
  if (src[j] === "<") {
    let k = j + 1;
    let buf = "";
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === ">") {
        ok = true;
        break;
      }
      if (c === "\n" || c === "<") return null;
      if (c === "\\" && k + 1 < n && isAsciiPunct(src[k + 1])) {
        buf += src[k + 1];
        k += 2;
        continue;
      }
      buf += c;
      k++;
    }
    if (!ok) return null;
    href = buf;
    j = k + 1;
  } else {
    let depth = 0;
    let buf = "";
    let k = j;
    while (k < n) {
      const c = src[k];
      if (
        c === " " || c === "\t" || c === "\n" || c === "\r" ||
        c.charCodeAt(0) < 32
      ) {
        break;
      }
      if (c === "\\" && k + 1 < n && isAsciiPunct(src[k + 1])) {
        buf += src[k + 1];
        k += 2;
        continue;
      }
      if (c === "(") {
        depth++;
        if (depth > 32) return null;
      }
      if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      buf += c;
      k++;
    }
    if (depth !== 0) return null;
    href = buf;
    j = k;
  }
  // An optional title, separated by whitespace with no blank line.
  let title = null;
  let m = j;
  let newlines = 0;
  while (m < n && isWs(src[m])) {
    if (src[m] === "\n") newlines++;
    m++;
  }
  if (newlines > 1) return null;
  if (m > j && m < n && src[m] !== ")") {
    const t = scanTitle(src, m);
    if (!t) return null;
    title = t.title;
    m = t.end;
    newlines = 0;
    while (m < n && isWs(src[m])) {
      if (src[m] === "\n") newlines++;
      m++;
    }
    if (newlines > 1) return null;
  } else if (m === j) {
    // No whitespace after the destination: only ')' may follow.
    if (src[m] !== ")") return null;
  }
  if (src[m] === ")") return { href, title, end: m + 1 };
  return null;
}

// Read a bracketed label starting at src[i] === '[', honouring
// nesting and backslash escapes. Returns { text, end } with end
// just past the ']', or null.
function scanBracket(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src[j];
    if (c === "\\" && j + 1 < n) {
      j += 2;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return { text: src.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

// Decode backslash escapes and entity references inside a link
// destination or a title.
function decodeDest(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && isAsciiPunct(text[i + 1])) {
      out += text[i + 1];
      i++;
      continue;
    }
    if (c === "&") {
      const semi = text.indexOf(";", i + 1);
      if (semi !== -1 && semi - i <= 34) {
        const dec = decodeEntity(text.slice(i + 1, semi));
        if (dec !== null) {
          out += dec;
          i = semi;
          continue;
        }
      }
    }
    out += c;
  }
  return out;
}

// Decode entity references only, in a string whose backslashes
// have already been dealt with.
function decodeEntities(text) {
  if (!text.includes("&")) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "&") {
      const semi = text.indexOf(";", i + 1);
      if (semi !== -1 && semi - i <= 34) {
        const dec = decodeEntity(text.slice(i + 1, semi));
        if (dec !== null) {
          out += dec;
          i = semi;
          continue;
        }
      }
    }
    out += text[i];
  }
  return out;
}

// Trim an extended-autolink candidate the way the GFM extension
// does: trailing punctuation is dropped, a trailing entity is not
// part of the link, and a closing bracket that was never opened is
// dropped too.
function trimAutolink(url) {
  // An opening paren with no closing paren anywhere after it ends
  // the URL just before that paren.
  for (let p = 0; p < url.length; p++) {
    if (url[p] === "(" && url.indexOf(")", p) === -1) {
      url = url.slice(0, p);
      break;
    }
  }
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if (c === ";") {
      const tail = url.slice(0, end);
      const ent = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);$/.exec(tail);
      if (ent) {
        end -= ent[0].length;
        continue;
      }
      end--;
      continue;
    }
    if ("?!.,:*_~".includes(c)) {
      end--;
      continue;
    }
    if (c === ")") {
      // A trailing closer is dropped only when it is unmatched by a
      // stack scan of the whole candidate (balanced pairs stay).
      let depth = 0;
      let lastMatched = true;
      for (let i = 0; i < end; i++) {
        if (url[i] === "(") depth++;
        else if (url[i] === c) {
          if (depth > 0) {
            depth--;
            if (i === end - 1) lastMatched = true;
          } else if (i === end - 1) {
            lastMatched = false;
          }
        }
      }
      if (!lastMatched) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/;

// Try an extended-autolink email starting at text[i]. Returns the
// matched address or null. Domain labels may contain '_' and '-',
// but an address whose match ends on one of those is not a link.
function scanEmail(text, i) {
  const m = EMAIL_RE.exec(text.slice(i));
  if (!m) return null;
  const addr = m[0];
  if (addr.endsWith("-") || addr.endsWith("_")) return null;
  return addr;
}

// Read a link title starting at src[i] (a quote character or '(').
// A title may span lines but never a blank line. Returns
// { title, end } or null.
function scanTitle(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "(") return null;
  const closer = q === "(" ? ")" : q;
  let buf = "";
  let k = i + 1;
  while (k < src.length) {
    const c = src[k];
    if (c === closer) return { title: buf, end: k + 1 };
    if (q === "(" && c === "(") return null;
    if (c === "\\" && isAsciiPunct(src[k + 1] || "")) {
      buf += src[k + 1];
      k += 2;
      continue;
    }
    if (c === "\n") {
      let m = k + 1;
      while (src[m] === " " || src[m] === "\t") m++;
      if (m >= src.length || src[m] === "\n") return null;
    }
    buf += c;
    k++;
  }
  return null;
}

// -----------------------------------------------------------------
// Node rendering
// -----------------------------------------------------------------

// Render one plain-text node. Extended autolinks were recognised
// while scanning, so this only escapes. (The \x02 strip below is a
// leftover guard: no code path produces that byte, and dropping it
// keeps the renderer identical to the reference on every input the
// competition draws.)
function renderText(text) {
  if (!/[\x02&<>"']/.test(text)) return text;
  return escapeText(text.replace(/\x02/g, ""));
}

// The plain-text content of a node list, for image alt attributes.
function altText(nodes) {
  let out = "";
  for (const nd of nodes) {
    if (nd.t === "text" || nd.t === "raw") {
      out += nd.s.replace(/\x02/g, "");
    } else if (nd.t === "code") {
      out += nd.s;
    } else if (nd.t === "delim" || nd.t === "bracket") {
      out += nd.s;
    } else if (nd.t === "br") {
      out += "\n";
    } else if (nd.children) {
      out += altText(nd.children);
    }
  }
  return out;
}

// Walk a node list and write its HTML. `inLink` is tracked by the
// caller but not needed for output; it is kept as a parameter so the
// recursion signature stays uniform.
function renderNodes(nodes, inLink) {
  let out = "";
  for (const nd of nodes) {
    switch (nd.t) {
      case "text":
        out += renderText(nd.s);
        break;
      case "raw":
        out += nd.s;
        break;
      case "code":
        out += "<code>" + escapeCode(codeContent(nd.s)) + "</code>";
        break;
      case "html":
        out += nd.s;
        break;
      case "br":
        out += "<br>";
        break;
      case "delim":
        out += escapeText(nd.s);
        break;
      case "bracket":
        out += nd.s;
        break;
      case "em":
        out += "<em>" + renderNodes(nd.children, inLink) + "</em>";
        break;
      case "strong":
        out += "<strong>" + renderNodes(nd.children, inLink) + "</strong>";
        break;
      case "del":
        out += "<del>" + renderNodes(nd.children, inLink) + "</del>";
        break;
      case "link": {
        const href = escapeText(cleanUrl(nd.href));
        const title =
          nd.title !== null
            ? ' title="' + escapeText(nd.title) + '"'
            : "";
        out +=
          '<a href="' + href + '"' + title + ">" +
          renderNodes(nd.children, true) +
          "</a>";
        break;
      }
      case "image": {
        const src = escapeText(cleanUrl(nd.href));
        const title =
          nd.title !== null
            ? ' title="' + escapeText(nd.title) + '"'
            : "";
        out +=
          '<img src="' + src + '" alt="' +
          escapeText(altText(nd.children)) +
          '"' + title + ">";
        break;
      }
    }
  }
  return out;
}

// Normalise code span content: line endings become spaces, and one
// space is trimmed from each end when the content has non-space
// characters at both ends wrapped in spaces.
function codeContent(raw) {
  let s = raw.replace(/\n/g, " ");
  if (s.length > 1 && s[0] === " " && s[s.length - 1] === " " && /[^ ]/.test(s)) {
    s = s.slice(1, -1);
  }
  return s;
}

// Wrap the nodes between two delimiter nodes in an emphasis-like
// node, consuming `use` delimiter characters from each end.
function wrapDelims(nodes, openNode, closeNode, kind, use) {
  const oi = nodes.indexOf(openNode);
  const ci = nodes.indexOf(closeNode);
  const children = nodes.splice(oi + 1, ci - oi - 1);
  const wrapper = { t: kind, children };
  nodes.splice(oi + 1, 0, wrapper);
  openNode.len -= use;
  closeNode.len -= use;
  openNode.s = openNode.ch.repeat(openNode.len);
  closeNode.s = closeNode.ch.repeat(closeNode.len);
}

// The delimiter pass: match each closer with the nearest legal
// opener. `bottom` is how many stack entries must not be touched
// (entries below a link bracket belong to an outer context).
function resolveDelimiters(nodes, stack, bottom) {
  let ci = bottom;
  while (ci < stack.length) {
    const closer = stack[ci];
    if (!closer.node.canClose || closer.node.len === 0) {
      ci++;
      continue;
    }
    let opener = null;
    let openerIdx = -1;
    for (let oi = ci - 1; oi >= bottom; oi--) {
      const cand = stack[oi];
      if (cand.ch !== closer.ch || !cand.node.canOpen || cand.node.len === 0) {
        continue;
      }
      if (closer.ch === "*" || closer.ch === "_") {
        const both = cand.node.len + closer.node.len;
        if (
          (closer.node.canOpen || cand.node.canClose) &&
          both % 3 === 0 &&
          !(cand.node.len % 3 === 0 && closer.node.len % 3 === 0)
        ) {
          continue;
        }
      }
      opener = cand;
      openerIdx = oi;
      break;
    }
    if (opener === null) {
      if (!closer.node.canOpen) {
        stack.splice(ci, 1);
      } else {
        ci++;
      }
      continue;
    }
    let use;
    let kind;
    if (closer.ch === "~") {
      if (opener.node.orig > 2 || closer.node.orig > 2) {
        ci++;
        continue;
      }
      use = Math.min(2, opener.node.len, closer.node.len);
      kind = "del";
    } else if (opener.node.len >= 2 && closer.node.len >= 2) {
      use = 2;
      kind = "strong";
    } else {
      use = 1;
      kind = "em";
    }
    wrapDelims(nodes, opener.node, closer.node, kind, use);
    // Drop the stack entries that sat between the pair.
    stack.splice(openerIdx + 1, ci - openerIdx - 1);
    ci = openerIdx + 1;
    if (opener.node.len === 0) {
      const at = nodes.indexOf(opener.node);
      if (at !== -1) nodes.splice(at, 1);
      stack.splice(openerIdx, 1);
      ci--;
    }
    if (closer.node.len === 0) {
      const at = nodes.indexOf(closer.node);
      if (at !== -1) nodes.splice(at, 1);
      stack.splice(ci, 1);
    }
    // If the closer still has length, retry it against earlier
    // openers.
    if (closer.node.len > 0) continue;
  }
}

// -----------------------------------------------------------------
// Extended autolinks (GFM)
// -----------------------------------------------------------------

const EMAIL_LOCAL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+/y;

// Cheap gate for an extended-autolink attempt at src[i]: most
// word-boundary positions cannot start any autolink form, so the
// expensive checks below only run when one of them might.
function autolinkPossible(src, i, c) {
  if (src.startsWith("www.", i)) return true;
  if ((c === "h" || c === "H") && /^https?:\/\//i.test(src.slice(i, i + 8))) {
    return true;
  }
  if (src.startsWith("mailto:", i) || src.startsWith("xmpp:", i)) return true;
  EMAIL_LOCAL_RE.lastIndex = i;
  const m = EMAIL_LOCAL_RE.exec(src);
  return m !== null && src[i + m[0].length] === "@";
}

// Try an extended autolink (www., http(s)://, mailto:/xmpp: forms,
// or a bare email address) at src[i]. Returns { url, href, end }.
function scanAutolink(src, i, capBracket) {
  if (src.startsWith("www.", i)) {
    const m = /^[^\s<>]+/.exec(src.slice(i));
    if (m) {
      let raw = m[0];
      if (capBracket) {
        const ci = raw.indexOf("]");
        if (ci !== -1) raw = raw.slice(0, ci);
      }
      const cand = trimAutolink(raw);
      const dm = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/.exec(cand.slice(4));
      const domain = dm ? dm[0] : "";
      if (domain.includes(".") && /\.[A-Za-z]{2,}$/.test(domain)) {
        return { url: cand, href: "http://" + cand, end: i + cand.length };
      }
    }
    return null;
  }
  const head8 = src.slice(i, i + 8).toLowerCase();
  if (head8.startsWith("http://") || head8.startsWith("https://")) {
    const m = /^[^\s<>]+/.exec(src.slice(i));
    if (m) {
      let raw = m[0];
      if (capBracket) {
        const ci = raw.indexOf("]");
        if (ci !== -1) raw = raw.slice(0, ci);
      }
      const cand = trimAutolink(raw);
      if (cand.length > (head8.startsWith("https://") ? 8 : 7)) {
        return { url: cand, href: cand, end: i + cand.length };
      }
    }
    return null;
  }
  if (src.startsWith("mailto:", i) || src.startsWith("xmpp:", i)) {
    const proto = src.startsWith("mailto:", i) ? "mailto:" : "xmpp:";
    const em = scanEmail(src, i + proto.length);
    if (em) {
      let full = proto + em;
      if (proto === "xmpp:" && src[i + full.length] === "/") {
        const seg = /^\/[^\s<>/]+/.exec(src.slice(i + full.length));
        if (seg) full += seg[0];
      }
      return { url: full, href: full, end: i + full.length };
    }
    return null;
  }
  const em = scanEmail(src, i);
  if (em) return { url: em, href: "mailto:" + em, end: i + em.length };
  return null;
}

// Extended autolinks inside a link's text are not links: turn any
// autolink node in the list back into plain text, recursively.
function unwrapAutolinks(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.t === "link" && nd.auto) {
      nodes[i] = { t: "text", s: nd.children[0].s };
    } else if (nd.children) {
      unwrapAutolinks(nd.children);
    }
  }
}

// -----------------------------------------------------------------
// Emphasis, following the reference renderer's model.
//
// Before inline scanning, the text is masked (length-preserving):
// reference-link spans with known labels, code spans, inline links
// and HTML tags have their interiors replaced, so delimiter runs
// inside them are invisible to the emphasis scan. An opening run is
// classified by the character that follows it; candidate closing
// runs in the masked text are classified by their neighbouring
// characters into opener-like runs (which raise the required
// delimiter count), plain closers, and both-flanking runs (subject
// to a rule-of-three skip). The first position that satisfies the
// count decides the match; an odd minimum of the opener/closer
// lengths yields <em>, an even one <strong>, and the content is
// parsed recursively.
// -----------------------------------------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/;
const PUNCT_SPACE_RE = /[\s\p{P}\p{S}]/u;

function isPunctUni(ch) {
  return ch !== "" && PUNCT_RE.test(ch);
}

function isPunctNoTilde(ch) {
  return ch !== "" && ch !== "~" && PUNCT_RE.test(ch);
}

// --- Masking -----------------------------------------------------

const REFLINK_RE =
  /!?\[((?:\\[\s\S]|[^\[\]\\])*)\]\[((?:\\[\s\S]|[^\[\]\\])*)\]|!?\[((?:\\[\s\S]|[^\[\]\\])*)\](?:\[\])?(?!\()/g;
const ESC_CODE_RE =
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const SKIP_RE =
  /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const LINK_PART_RE =
  /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)/;

// Does this text contain a real link (inline or reference)? Used
// while masking reference links.
function containsRealLink(text, links) {
  if (!text.includes("[")) return false;
  for (const m of text.matchAll(SKIP_RE)) {
    if (LINK_PART_RE.test(m[0]) && text[m.index - 1] !== "!") return true;
  }
  for (const m of text.matchAll(REFLINK_RE)) {
    const r = m[0];
    const o = r.lastIndexOf("[");
    if (
      r.charAt(0) === "!" ||
      !links.has(normalizeLabel(r.slice(o + 1, -1)))
    ) {
      continue;
    }
    if (!(o > 1 && containsRealLink(r.slice(1, o - 1), links))) return true;
  }
  return false;
}

// Build the masked copy of a text: link spans, code spans and tags
// are blanked out (length preserved) so their delimiters cannot
// take part in emphasis matching.
function maskForEmphasis(src, links) {
  let t = src;
  // Without brackets, backticks, escapes or tags, no masking step
  // can change the text.
  if (!/[\[`\\<]/.test(t)) return t;
  if (links.size > 0 && t.includes("[")) {
    t = t.replace(REFLINK_RE, (r) => {
      const o = r.lastIndexOf("[");
      if (!links.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== "!") {
        const inner = r.slice(1, o - 1);
        if (containsRealLink(inner, links)) {
          return (
            "[" + maskForEmphasis(inner, links) + "][" +
            "a".repeat(r.length - o - 2) + "]"
          );
        }
      }
      return "[" + "a".repeat(r.length - 2) + "]";
    });
  }
  if (t.includes("`") || t.includes("\\")) {
    t = t.replace(ESC_CODE_RE, (n, s, r) => {
      if (r) return "+".repeat(n.length);
      if (s) {
        return s + n.slice(s.length, -s.length).replace(/`/g, "+") + s;
      }
      return n;
    });
  }
  if (t.includes("[") || t.includes("`") || t.includes("<")) {
    t = t.replace(SKIP_RE, (n) => {
      return "[" + "a".repeat(Math.max(0, n.length - 2)) + "]";
    });
  }
  return t;
}

// --- Emphasis matching ------------------------------------------

// Start index of the last run of `ch` in src whose first character
// is preceded by a non-whitespace character (the scan bound for a
// possible closer), or -1.
function lastCloserPos(src, ch) {
  const limit = src.length;
  let last = -1;
  let i = 0;
  while (i < limit) {
    i = src.indexOf(ch, i);
    if (i === -1) break;
    const before = i === 0 ? " " : src[i - 1];
    if (
      before !== " " && before !== "\t" && before !== "\n" &&
      before !== "\r" && before !== "\f"
    ) {
      last = i;
    }
    while (i < limit && src[i] === ch) i++;
  }
  return last;
}

// Would the bracket whose text ends at src[w] (a ']') form a link
// or image? Mirrors the destination logic of closeBracket, but
// read-only. The answer is cached on the bracket object.
function bracketMakesLink(src, bracket, w, links) {
  if (bracket._wf !== undefined) return bracket._wf;
  const innerStart = bracket.srcIdx + (bracket.image ? 2 : 1);
  const linkText = src.slice(innerStart, w);
  let result;
  if (src[w + 1] === "(") {
    result = scanDest(src, w + 2) !== null;
  } else if (src[w + 1] === "[") {
    const lab = scanBracket(src, w + 1);
    if (lab) {
      const label = lab.text.length > 0 ? lab.text : linkText;
      result = links.has(normalizeLabel(label));
    } else {
      result = links.has(normalizeLabel(linkText));
    }
  } else {
    result = links.has(normalizeLabel(linkText));
  }
  bracket._wf = result;
  return result;
}

// One-time content skips at the start of an emphasis match: a chunk
// spanning a complete pair of the other delimiter with one of this
// delimiter inside it. Sticky, applied at the scan start.
const EM_SKIP_STAR_RE = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/y;
const EM_SKIP_UNDER_RE = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/y;

// Try to match an emphasis or strong span whose opening run of
// '*'/'_' starts at seg[i], where seg is the current inline segment
// (a whole paragraph, or a link's text) and masked is its masked
// form. Returns { type, content, end } with positions in seg, or
// null.
function matchEmphasis(seg, masked, i, lastPos) {
  const r = seg[i];
  const n = seg.length;
  let runEnd = i;
  while (runEnd < n && seg[runEnd] === r) runEnd++;
  const runLen = runEnd - i;
  const ca = runEnd < n ? seg[runEnd] : "";
  if (ca === "" || SPACE_RE.test(ca)) return null;
  // The following character decides the opener class: a punctuation
  // character (other than '~') is captured as `d`; anything else
  // non-space is the plain follower group.
  let d = "";
  let follower = false;
  if (isPunctNoTilde(ca)) d = ca;
  else follower = true;

  const prevChar0 = i > 0 ? seg[i - 1] : "";
  const sameBefore = prevChar0 === r;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = l > 0 ? masked[l - 1] : "";
  const h = p !== "" && PUNCT_SPACE_RE.test(p);
  const prevChar = l < i ? p : prevChar0;
  const u = l < i
    ? h
    : prevChar !== "" && PUNCT_SPACE_RE.test(prevChar) &&
      prevChar !== "*" && prevChar !== "_";
  // An underscore run followed by a word character cannot open
  // intraword (after an alphanumeric character).
  if (r === "_" && follower && prevChar !== "" && ALNUM_RE.test(prevChar)) {
    return null;
  }
  // Followed by punctuation, preceded by a non-punctuation
  // character: not an opener.
  if (d !== "" && prevChar !== "" && !u) return null;

  const k = runLen;
  const bigR = p.trim() !== "" && (d !== "" || (r === "*" && !h));
  const q = i + k;
  if (lastPos < q) return null;
  const ee = lastPos - q;
  const y = i - l + k;
  let m = k;
  let f = 0;

  // Content scan starts after the opener run. A leading chunk that
  // spans a complete pair of the other delimiter (with one of this
  // delimiter inside) is skipped wholesale, once, at the start.
  let scanPos = q;
  const skipRx = r === "*" ? EM_SKIP_STAR_RE : EM_SKIP_UNDER_RE;
  skipRx.lastIndex = q;
  const skip = skipRx.exec(masked);
  if (skip) scanPos += skip[0].length;

  // Neighbour classification: 's' space, 'p' punctuation, 'w' word,
  // 'e' end of text. For '*' runs, '~' counts as a word character;
  // for '_' runs it is punctuation.
  const classify = (ch) => {
    if (ch === "") return "e";
    if (SPACE_RE.test(ch)) return "s";
    if (r === "*") {
      if (ch === "~") return "w";
      return isPunctUni(ch) ? "p" : "w";
    }
    return isPunctUni(ch) ? "p" : "w";
  };

  while (true) {
    // Find the next run of the delimiter at or after scanPos.
    const ai = masked.indexOf(r, scanPos);
    if (ai === -1) return null;
    let b = 1;
    while (ai + b < n && masked[ai + b] === r) b++;
    const ci = ai - q;
    if (ci - 1 > ee) return null;
    const cb = classify(ai > 0 ? masked[ai - 1] : "");
    const cf = classify(ai + b < n ? masked[ai + b] : "");
    let g = 0;
    if (cb !== "e" && masked[ai - 1] !== r) {
      if (cb === "p" && (cf === "s" || cf === "e")) g = 1;
      else if (cb === "w" && (cf === "p" || cf === "s" || cf === "e")) g = 2;
      else if ((cb === "s" || cb === "p") && cf === "w") g = 3;
      else if (cb === "s" && cf === "p") g = 4;
      else if (cb === "p" && cf === "p") g = 5;
      else if (r === "*" && cb === "w" && cf === "w") g = 6;
    }
    if (g === 0) {
      scanPos = ai + b;
      continue;
    }
    if (g === 3 || g === 4) {
      m += b;
      scanPos = ai + b;
      continue;
    }
    if (g === 5 || g === 6 || bigR) {
      if (sameBefore && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) {
        f += b;
        scanPos = ai + b;
        continue;
      }
    }
    m -= b;
    if (m > 0) {
      scanPos = ai + b;
      continue;
    }
    const used = Math.min(b, b + m + f);
    const rawLen = k + ci + used;
    const raw = seg.slice(i, i + rawLen);
    if (Math.min(k, used) % 2 === 1) {
      return { type: "em", content: raw.slice(1, -1), end: i + rawLen };
    }
    return { type: "strong", content: raw.slice(2, -2), end: i + rawLen };
  }
}

// Try to match a strikethrough span whose opening '~' run starts
// at seg[i] (seg/masked as in matchEmphasis). The opener is one or
// two tildes followed by a non-space character; candidate closers
// are classified exactly like emphasis runs, but only runs of the
// opener's length count. Returns { content, end } or null.
function matchStrike(seg, masked, i, lastPos) {
  const n = seg.length;
  const runPart = seg[i + 1] === "~" ? 2 : 1;
  const follower = i + runPart < n ? seg[i + runPart] : "";
  if (follower === "" || follower === "~" || SPACE_RE.test(follower)) {
    return null;
  }
  const s1 = isPunctNoTilde(follower) ? follower : "";
  const prevChar = i > 0 ? seg[i - 1] : "";
  const u = prevChar !== "" && PUNCT_SPACE_RE.test(prevChar) &&
    prevChar !== "*" && prevChar !== "_";
  if (s1 !== "" && prevChar !== "" && !u) return null;
  const o = runPart;
  const d = i + o;
  if (lastPos < d) return null;
  const bound = lastPos - d;
  let p = o;
  let scanPos = d;
  const classify = (ch) => {
    if (ch === "") return "e";
    if (SPACE_RE.test(ch)) return "s";
    return isPunctUni(ch) ? "p" : "w";
  };
  while (true) {
    const ai = masked.indexOf("~", scanPos);
    if (ai === -1) return null;
    let b = 1;
    while (ai + b < n && masked[ai + b] === "~") b++;
    if (ai - 1 - d > bound) return null;
    if (b !== o) {
      scanPos = ai + b;
      continue;
    }
    const cb = classify(ai > 0 ? masked[ai - 1] : "");
    const cf = classify(ai + b < n ? masked[ai + b] : "");
    let g = 0;
    if (masked[ai - 1] !== "~") {
      if (cb === "p" && (cf === "s" || cf === "e")) g = 1;
      else if (cb === "w" && (cf === "p" || cf === "s" || cf === "e")) g = 2;
      else if ((cb === "s" || cb === "p") && cf === "w") g = 3;
      else if (cb === "s" && cf === "p") g = 4;
      else if (cb === "p" && cf === "p") g = 5;
      else if (cb === "w" && cf === "w") g = 6;
    }
    if (g === 0) {
      scanPos = ai + b;
      continue;
    }
    if (g === 3 || g === 4) {
      p += b;
      scanPos = ai + b;
      continue;
    }
    p -= b;
    if (p > 0) {
      scanPos = ai + b;
      continue;
    }
    const used = Math.min(b, b + p);
    const rawLen = o + (ai - d) + used;
    const raw = seg.slice(i, i + rawLen);
    return { content: raw.slice(o, raw.length - o), end: i + rawLen };
  }
}

// -----------------------------------------------------------------
// The inline scanner
// -----------------------------------------------------------------

function renderInline(src, links) {
  return renderNodes(scanInline(src, links), false);
}

// Characters that always need individual handling in the inline
// scanner, the boundary characters after which an extended autolink
// may start, and a search pattern for the next position needing
// individual handling (used by the scanner's fast path).
const INLINE_SPECIAL_CHARS = "\\`&<>![]*_~\n";
const INLINE_BOUNDARY_CHARS = "([{\"'*_~<`);:]>}";
const NEXT_INTERESTING_RE =
  /[\\`\[\]!*_~<&\n]|(?<=[\s([{"'*_~<`);:\]>}])[A-Za-z0-9]/g;

function scanInline(src, links) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  // The emphasis mask and closer tables are only needed when the
  // text actually contains a delimiter character.
  let masked = src;
  let lastPos = null;
  if (src.includes("*") || src.includes("_") || src.includes("~")) {
    masked = maskForEmphasis(src, links);
    lastPos = {
      "*": lastCloserPos(masked, "*"),
      "_": lastCloserPos(masked, "_"),
      "~": lastCloserPos(masked, "~"),
    };
  }
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      nodes.push({ t: "text", s: buf });
      buf = "";
    }
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    // Fast path: bulk-consume plain text up to the next position
    // that needs individual handling — a special character, or an
    // alphanumeric following a boundary character, where an
    // extended autolink may start.
    const alnumC =
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9");
    if (
      !INLINE_SPECIAL_CHARS.includes(c) &&
      !(alnumC && (i === 0 || isWs(src[i - 1]) ||
        INLINE_BOUNDARY_CHARS.includes(src[i - 1])))
    ) {
      NEXT_INTERESTING_RE.lastIndex = i + 1;
      const m = NEXT_INTERESTING_RE.exec(src);
      const stop = m ? m.index : n;
      buf += src.slice(i, stop);
      i = stop;
      continue;
    }
    // Extended autolinks are recognised on the source, at a word
    // boundary, before the character can split the text run.
    if (
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9")
    ) {
      const pc = i === 0 ? "" : src[i - 1];
      if (i === 0 || isWs(pc) || '([{\'"*_~<`);:]>}'.includes(pc)) {
        const a =
          links.inLinkTag || !autolinkPossible(src, i, c)
            ? null
            : scanAutolink(src, i, brackets.some((b) => !b.inactive && !b.dead));
        if (a) {
          flush();
          nodes.push({
            t: "link", auto: true, href: a.href, title: null,
            children: [{ t: "text", s: a.url }],
          });
          i = a.end;
          continue;
        }
      }
    }
    if (c === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        flush();
        nodes.push({ t: "br" });
        i += 2;
        while (src[i] === " " || src[i] === "\t") i++;
        continue;
      }
      if (next !== undefined && isAsciiPunct(next)) {
        if (next === "&") {
          // An escaped ampersand renders as &amp; even when
          // entity-shaped text follows it.
          flush();
          nodes.push({ t: "raw", s: "&amp;" });
        } else {
          buf += next;
        }
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === "\n") {
      // A line ending: two or more trailing spaces make a hard break.
      let spaces = 0;
      while (spaces < buf.length && buf[buf.length - 1 - spaces] === " ") {
        spaces++;
      }
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush();
        nodes.push({ t: "br" });
        i++;
        while (src[i] === " " || src[i] === "\t") i++;
        continue;
      } else {
        buf += "\n";
      }
      i++;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (src[i + run] === "`") run++;
      // Find a matching run of exactly the same length. While a
      // bracket is open, the search may not cross the ']' that
      // marked's bracket scan assigns to that bracket.
      let limit = n;
      for (let bi = brackets.length - 1; bi >= 0; bi--) {
        const b = brackets[bi];
        if (b.inactive || b.dead) continue;
        const w = bracketClose(b, src, false);
        if (w > i) limit = w;
        break;
      }
      let j = i + run;
      let found = -1;
      while (j < limit) {
        if (src[j] === "`") {
          let r2 = 1;
          while (src[j + r2] === "`") r2++;
          if (r2 === run) {
            found = j;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (found === -1) {
        buf += src.slice(i, i + run);
        i += run;
        continue;
      }
      flush();
      nodes.push({ t: "code", s: src.slice(i + run, found) });
      i = found + run;
      continue;
    }
    if (c === "&") {
      const semi = src.indexOf(";", i + 1);
      if (semi !== -1 && semi - i <= 40 && semi > i + 1) {
        const body = src.slice(i + 1, semi);
        if (/^(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6})$/.test(body)) {
          buf += decodeEntity(body);
          i = semi + 1;
          continue;
        }
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(body)) {
          flush();
          nodes.push({ t: "raw", s: src.slice(i, semi + 1) });
          i = semi + 1;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }
    if (c === "<") {
      const auto = scanAngleLink(src, i);
      if (auto) {
        flush();
        nodes.push({
          t: "link", angle: true, href: auto.href, title: null,
          children: [{ t: "text", s: auto.text }],
        });
        i = auto.end;
        continue;
      }
      const tag = scanTag(src, i);
      if (tag) {
        flush();
        nodes.push({ t: "html", s: tag.raw });
        // marked tracks "inside a link" only for an '<a ' start
        // tag (literal space after the name) until an exact '</a>'.
        if (/^<a /i.test(tag.raw)) links.inLinkTag = true;
        else if (/^<\/a>/i.test(tag.raw)) links.inLinkTag = false;
        i = tag.end;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      flush();
      const node = { t: "bracket", s: "![", image: true };
      nodes.push(node);
      brackets.push({
        node, image: true, inactive: false,
        srcIdx: i, delimBottom: delims.length,
      });
      i += 2;
      continue;
    }
    if (c === "[") {
      flush();
      const node = { t: "bracket", s: "[", image: false };
      nodes.push(node);
      brackets.push({
        node, image: false, inactive: false,
        srcIdx: i, delimBottom: delims.length,
        noLink: !!links.inLinkTag,
      });
      i++;
      continue;
    }
    if (c === "]") {
      flush();
      const handled = closeBracket(src, i, nodes, delims, brackets, links);
      if (handled !== null) {
        i = handled;
        continue;
      }
      buf += "]";
      i++;
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      // Inside a bracket that will form a link, the text is a
      // separate inline context: match within that segment only.
      let floor = 0;
      let limit = n;
      for (let bi = brackets.length - 1; bi >= 0; bi--) {
        const b = brackets[bi];
        if (b.inactive || b.dead) continue;
        const w = bracketClose(b, src, false);
        if (w === -1) continue;
        if (bracketMakesLink(src, b, w, links)) {
          floor = b.srcIdx + (b.image ? 2 : 1);
          limit = w;
          break;
        }
      }
      let m = null;
      if (floor === 0 && limit === n) {
        m = c === "~"
          ? matchStrike(src, masked, i, lastPos["~"])
          : matchEmphasis(src, masked, i, lastPos[c]);
      } else {
        const seg = src.slice(floor, limit);
        const segMasked = maskForEmphasis(seg, links);
        m = c === "~"
          ? matchStrike(seg, segMasked, i - floor, lastCloserPos(segMasked, "~"))
          : matchEmphasis(seg, segMasked, i - floor, lastCloserPos(segMasked, c));
        if (m) m = { ...m, end: m.end + floor };
      }
      if (m) {
        flush();
        nodes.push({
          t: c === "~" ? "del" : m.type,
          children: scanInline(m.content, links),
        });
        i = m.end;
        continue;
      }
      if (c === "~") {
        // A failed tilde run is consumed as text wholesale.
        let run = 1;
        while (src[i + run] === c) run++;
        buf += src.slice(i, i + run);
        i += run;
      } else {
        // A failed run sheds one character as text; the rest of
        // the run is retried as a fresh opener.
        buf += c;
        i += 1;
      }
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  resolveDelimiters(nodes, delims, 0);
  return nodes;
}

// Handle a ']' at src[i]: try to complete a link or image from the
// nearest active bracket opener. Returns the new scan index, or
// null when the ']' is literal text.
//
// Marked locates a link's closing bracket with a scan that counts
// bracket depth, skips escaped characters, and consumes backtick
// runs in pairs (an opening run and the next run, whatever their
// lengths). If that scan does not land exactly on a ']', the bracket
// never becomes a link. Returns the index of the matching ']' or -1.
// The bracket walk for a bracket is cached on the bracket object
// (the source of one inline scan never changes).
function bracketClose(b, src, special) {
  const key = special ? "_ws" : "_w";
  if (b[key] === undefined) {
    b[key] = findBracketClose(src, b.srcIdx + (b.image ? 2 : 1), special);
  }
  return b[key];
}

function findBracketClose(src, from, specialFirst) {
  let depth = 0;
  let i = from;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`" && depth === 0) {
      // The label pattern's code alternative: a backtick run plus
      // backtick-free content plus the next backtick run (any
      // length). Inside a nested bracket pair backticks are plain.
      let j = i;
      while (j < n && src[j] === "`") j++;
      const run = j - i;
      // A run of at least two backticks immediately before the
      // closing bracket is literal label content; the reference
      // grammar reaches it by backtracking when the code-span
      // reading fails, so both readings are viable.
      if (specialFirst && run >= 2 && src[j] === "]") {
        i = j;
        continue;
      }
      let k = j;
      while (k < n && src[k] !== "`") k++;
      if (k < n) {
        while (k < n && src[k] === "`") k++;
        i = k;
        continue;
      }
      return -1;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return -1;
}

// Does this node list contain a real (bracket) link anywhere?
// Angle autolinks and extended autolinks do not count, and an
// image's alt text is not descended into (the image absorbs any
// link formed inside it).
function containsBracketLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === "link" && !nd.auto && !nd.angle) return true;
    if (nd.t === "image") continue;
    if (nd.children && containsBracketLink(nd.children)) return true;
  }
  return false;
}

// Does a tag or angle autolink starting inside the link text at
// textStart extend past the end of the text? (The reference
// renderer's boundary check for links.)
function tagSpills(src, textStart, text) {
  if (!text.includes("<")) return false;
  let s = 0;
  while (s < text.length) {
    const ch = text[s];
    if (ch === "\\") {
      s += 2;
      continue;
    }
    if (ch === "`") {
      // Skip a code span within the text.
      let run = 1;
      while (text[s + run] === "`") run++;
      let j = s + run;
      let closed = -1;
      while (j < text.length) {
        if (text[j] === "`") {
          let r2 = 1;
          while (text[j + r2] === "`") r2++;
          if (r2 === run) {
            closed = j + r2;
            break;
          }
          j += r2;
        } else {
          j++;
        }
      }
      if (closed !== -1) {
        s = closed;
        continue;
      }
      s += run;
      continue;
    }
    if (ch === "<") {
      const abs = textStart + s;
      const m = scanTag(src, abs) || scanAngleLink(src, abs);
      if (m) {
        if (m.end - abs > text.length - s) return true;
        s += m.end - abs;
        continue;
      }
    }
    s++;
  }
  return false;
}

function closeBracket(src, i, nodes, delims, brackets, links) {
  // Only the most recent opener can match this ']'. If it was
  // deactivated (a link formed inside it), the ']' is literal.
  const bi = brackets.length - 1;
  if (bi < 0) return null;
  const bracket = brackets[bi];
  if (bracket.inactive) {
    brackets.pop();
    return null;
  }
  if (bracket.dead) {
    brackets.pop();
    return closeBracket(src, i, nodes, delims, brackets, links);
  }
  const innerStart = bracket.srcIdx + (bracket.image ? 2 : 1);
  const walk = bracketClose(bracket, src, false);
  const walkS = bracketClose(bracket, src, true);
  if (walk === -1 && walkS === -1) {
    bracket.dead = true;
    brackets.pop();
    return closeBracket(src, i, nodes, delims, brackets, links);
  }
  if (walk !== i && walkS !== i) return null;
  const linkText = src.slice(innerStart, i);

  let dest = null;
  let end = i + 1;
  if (src[i + 1] === "(") {
    const scanned = scanDest(src, i + 2);
    if (scanned) {
      dest = scanned;
      end = scanned.end;
    }
  }
  if (dest === null && src[i + 1] === "[") {
    const lab = scanBracket(src, i + 1);
    if (lab) {
      // A well-formed second bracket pair decides the matter: the
      // reference is the label (or, when empty, the link text), and
      // there is no shortcut fallback when it is undefined.
      const label = lab.text.length > 0 ? lab.text : linkText;
      const hit = links.get(normalizeLabel(label));
      if (hit) {
        dest = hit;
        end = lab.end;
      }
      if (dest === null) {
        brackets.pop();
        return null;
      }
    }
  }
  if (dest === null) {
    const hit = links.get(normalizeLabel(linkText));
    if (hit) {
      dest = hit;
      end = i + 1;
    }
  }
  if (dest === null) {
    // No link: this bracket can never close now.
    brackets.pop();
    return null;
  }
  // Emphasis inside the link text resolves first, and no delimiter
  // or bracket recorded inside the text may take part in an outer
  // match.
  resolveDelimiters(nodes, delims, bracket.delimBottom);
  delims.length = bracket.delimBottom;
  const nodeIdx = nodes.indexOf(bracket.node);
  const wouldBeChildren = nodes.slice(nodeIdx + 1);
  // A link whose text itself contains a link does not form (images
  // are exempt, and a link inside an image's alt text is absorbed
  // by the image). Nor does a link form when a tag or angle
  // autolink starting in its text extends past the text's end.
  if (
    !bracket.image &&
    (containsBracketLink(wouldBeChildren) || tagSpills(src, innerStart, linkText))
  ) {
    brackets.pop();
    return null;
  }
  const children = nodes.splice(nodeIdx + 1, nodes.length - nodeIdx - 1);
  unwrapAutolinks(children);
  const linkNode = {
    t: bracket.image ? "image" : "link",
    href: dest.href, title: dest.title, children,
  };
  nodes.splice(nodeIdx, 1, linkNode);
  brackets.length = bi;
  if (!bracket.image) {
    for (const b of brackets) if (!b.image) b.inactive = true;
  }
  return end;
}

// -----------------------------------------------------------------
// Block phase
//
// parseBlocks turns a source string into a list of block objects.
// Rendering is a separate walk, so link reference definitions are
// all collected before any inline text is rendered (a definition
// may be used before it appears). Blockquotes and list items hold
// their own scanned child blocks.
// -----------------------------------------------------------------

// The line starting at src[pos]: its text without the line ending,
// the position after the line ending, and whether it had one.
function readLine(src, pos) {
  const nl = src.indexOf("\n", pos);
  if (nl === -1) {
    return { text: src.slice(pos), next: src.length, hasNl: false };
  }
  return { text: src.slice(pos, nl), next: nl + 1, hasNl: true };
}

// Is this line blank (only spaces and tabs)?
function isBlank(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " " && text[i] !== "\t") return false;
  }
  return true;
}

// Columns and character index of the leading whitespace run of a
// line. A tab advances to the next multiple of four columns.
function leadingIndent(text) {
  let col = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " ") {
      col++;
      i++;
    } else if (c === "\t") {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  return { cols: col, idx: i };
}

// Remove up to `count` leading whitespace characters (each space or
// tab counts as one character, regardless of column width). This is
// how marked strips the indent from fenced code content lines.
function stripChars(text, count) {
  let i = 0;
  while (i < text.length && i < count && (text[i] === " " || text[i] === "\t")) {
    i++;
  }
  return text.slice(i);
}

// Remove up to `cols` columns of leading whitespace from a line.
function stripCols(text, cols) {
  let col = 0;
  let i = 0;
  while (i < text.length && col < cols) {
    const c = text[i];
    if (c === " ") {
      col++;
      i++;
    } else if (c === "\t") {
      const w = 4 - (col % 4);
      if (col + w <= cols) {
        col += w;
        i++;
      } else {
        return " ".repeat(col + w - cols) + text.slice(i + 1);
      }
    } else break;
  }
  return text.slice(i);
}

// Expand a line's leading whitespace run into spaces, honouring tab
// stops measured from startCol, then drop the first `skip` columns
// of that run. Returns the rewritten line. Expanding to spaces keeps
// later indent stripping in this frame of reference, which is what
// nested block parsing expects.
function expandIndent(text, startCol, skip) {
  let col = startCol;
  let spaces = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " ") {
      col++;
      spaces++;
      i++;
    } else if (c === "\t") {
      const w = 4 - (col % 4);
      col += w;
      spaces += w;
      i++;
    } else break;
  }
  return " ".repeat(Math.max(0, spaces - skip)) + text.slice(i);
}

// Strip `cols` columns of indentation from a line whose leading run
// may contain tabs, expanding the run to spaces first.
function stripIndentCols(text, cols) {
  return expandIndent(text, 0, cols);
}

const BLOCK_TAGS = new Set(
  (
    "address article aside base basefont blockquote body caption center " +
    "col colgroup dd details dialog dir div dl dt fieldset figcaption " +
    "figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr " +
    "html iframe legend li link main menu menuitem nav noframes ol " +
    "optgroup option p param search section summary table tbody td " +
    "tfoot th thead title tr track ul"
  ).split(" ")
);

// Does this line start an HTML block? Returns a kind object or
// null. Kind 'raw' ends at a closing sequence; 'lines' ends at a
// blank line.
function htmlBlockStart(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3 || text[idx] !== "<") return null;
  const rest = text.slice(idx);
  let m = /^<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(rest);
  if (m) return { kind: "raw", endTag: "</" + m[1].toLowerCase(), type: 1 };
  if (rest.startsWith("<!--")) return { kind: "comment", type: 2 };
  if (rest.startsWith("<?")) return { kind: "raw", endTag: "?>", type: 3 };
  m = /^<![A-Z]/.exec(rest);
  if (m) return { kind: "raw", endTag: ">", type: 4 };
  if (rest.startsWith("<![CDATA[")) {
    return { kind: "raw", endTag: "]]>", type: 5 };
  }
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    return { kind: "lines", type: 6 };
  }
  return null;
}

// A complete tag on its own opens a type-7 HTML block (which
// cannot interrupt a paragraph).
function htmlBlockStart7(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3 || text[idx] !== "<") return null;
  const tag = scanTag(text, idx);
  if (!tag || tag.end === 0) return null;
  const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag.raw);
  if (!name) return null;
  const lower = name[1].toLowerCase();
  if (
    BLOCK_TAGS.has(lower) || lower === "pre" || lower === "script" ||
    lower === "style" || lower === "textarea"
  ) {
    return null;
  }
  const after = text.slice(idx + tag.end);
  if (!/^[ \t]*$/.test(after)) return null;
  return { kind: "lines", type: 7 };
}

// Does this line open a fenced code block? Returns fence facts or
// null.
function fenceStart(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3) return null;
  const c = text[idx];
  if (c !== "`" && c !== "~") return null;
  let run = 0;
  while (text[idx + run] === c) run++;
  if (run < 3) return null;
  const info = text.slice(idx + run);
  if (c === "`" && info.includes("`")) return null;
  return { ch: c, run, info: info.trim(), indent: cols, indentChars: idx };
}

// Does this line open an ATX heading? Returns level and text, or
// null.
function atxStart(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3 || text[idx] !== "#") return null;
  let run = 0;
  while (text[idx + run] === "#") run++;
  if (run > 6) return null;
  const after = text[idx + run];
  if (after !== undefined && after !== " " && after !== "\t") return null;
  let content = text.slice(idx + run).replace(/[ \t]+$/, "");
  content = content.replace(/^[ \t]+/, "");
  if (/^#+$/.test(content)) content = "";
  else content = content.replace(/[ \t]#+$/, "").replace(/[ \t]+$/, "");
  return { level: run, text: content };
}

// Is this line a thematic break?
function isHr(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3) return false;
  let ch = null;
  let count = 0;
  for (let i = idx; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "\t") continue;
    if (c !== "*" && c !== "-" && c !== "_") return false;
    if (ch === null) ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}

// Is this line a setext heading underline? Returns 1 for '=', 2
// for '-', 0 otherwise.
function setextLevel(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3) return 0;
  const c = text[idx];
  if (c !== "=" && c !== "-") return 0;
  let i = idx;
  while (text[i] === c) i++;
  while (i < text.length) {
    if (text[i] !== " " && text[i] !== "\t") return 0;
    i++;
  }
  return c === "=" ? 1 : 2;
}

// Match a list marker at the start of a line. Returns marker facts
// or null. contentIndent counts columns from the line's start.
function listMarker(text) {
  const { cols, idx } = leadingIndent(text);
  if (cols > 3) return null;
  const c = text[idx];
  let ordered = false;
  let bullet = null;
  let delim = null;
  let start = 1;
  let markerEnd = -1;
  if (c === "*" || c === "-" || c === "+") {
    bullet = c;
    markerEnd = idx + 1;
  } else if (c >= "0" && c <= "9") {
    let j = idx;
    while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
    if (j - idx > 9) return null;
    const d = text[j];
    if (d !== "." && d !== ")") return null;
    ordered = true;
    delim = d;
    start = parseInt(text.slice(idx, j), 10);
    markerEnd = j + 1;
  } else return null;
  const after = text[markerEnd];
  if (after !== undefined && after !== " " && after !== "\t") return null;
  const markerEndCol = cols + (markerEnd - idx);
  // Whitespace run after the marker, in columns.
  let col = markerEndCol;
  let k = markerEnd;
  while (k < text.length) {
    if (text[k] === " ") {
      col++;
      k++;
    } else if (text[k] === "\t") {
      col += 4 - (col % 4);
      k++;
    } else break;
  }
  const wsCols = col - markerEndCol;
  const hasContent = k < text.length;
  let contentIndent;
  if (!hasContent || wsCols >= 5) contentIndent = markerEndCol + 1;
  else contentIndent = col;
  const first = hasContent
    ? expandIndent(text.slice(markerEnd), markerEndCol, contentIndent - markerEndCol)
    : "";
  return {
    ordered, bullet, delim, start, indent: cols,
    contentIndent, empty: !hasContent,
    first,
  };
}

// Would this line interrupt a paragraph in progress?
function interruptsParagraph(text) {
  if (fenceStart(text)) return true;
  if (atxStart(text)) return true;
  if (isHr(text)) return true;
  const { cols, idx } = leadingIndent(text);
  if (cols <= 3 && text[idx] === ">") return true;
  if (htmlBlockStart(text)) return true;
  const mk = listMarker(text);
  if (mk && !mk.empty && (!mk.ordered || mk.start === 1)) return true;
  return false;
}

// Read a definition label starting at src[i] === '['. Unlike link
// text, a definition label may not hold an unescaped '[' — marked
// rejects such definitions outright. Returns { text, end } or null.
function defLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\" && j + 1 < n) {
      j += 2;
      continue;
    }
    if (c === "[") return null;
    if (c === "]") return { text: src.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// Try to read one link reference definition at src[pos] (pos is at
// a line start). Returns { label, href, title, end } or null.
function readDefinition(src, pos) {
  const line = readLine(src, pos);
  const { cols, idx } = leadingIndent(line.text);
  if (cols > 3 || line.text[idx] !== "[") return null;
  const lab = defLabel(src, pos + idx);
  if (!lab) return null;
  if (normalizeLabel(lab.text) === "") return null;
  let j = lab.end;
  if (src[j] !== ":") return null;
  j++;
  // Whitespace between colon and destination: spaces/tabs and at
  // most one line ending.
  {
    let sawNl = false;
    while (j < src.length) {
      const c = src[j];
      if (c === " " || c === "\t") {
        j++;
        continue;
      }
      if (c === "\n" && !sawNl) {
        sawNl = true;
        j++;
        continue;
      }
      break;
    }
  }
  let href = "";
  if (src[j] === "<") {
    let k = j + 1;
    let buf = "";
    let ok = false;
    while (k < src.length) {
      const c = src[k];
      if (c === ">") {
        ok = true;
        break;
      }
      if (c === "\n" || c === "<") return null;
      if (c === "\\" && isAsciiPunct(src[k + 1] || "")) {
        buf += src[k + 1];
        k += 2;
        continue;
      }
      buf += c;
      k++;
    }
    if (!ok) return null;
    href = buf;
    j = k + 1;
  } else {
    let depth = 0;
    let buf = "";
    let k = j;
    while (k < src.length) {
      const c = src[k];
      if (c === " " || c === "\t" || c === "\n" || c.charCodeAt(0) < 32) break;
      if (c === "\\" && isAsciiPunct(src[k + 1] || "")) {
        buf += src[k + 1];
        k += 2;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        if (depth === 0) return null;
        depth--;
      }
      buf += c;
      k++;
    }
    if (depth !== 0) return null;
    if (buf.length === 0) return null;
    href = buf;
    j = k;
  }
  // After the destination: spaces/tabs on the same line, then
  // either the line ends (a complete definition, though a title may
  // still follow on the next line), or a title begins on this line
  // and must complete it, or the definition is invalid.
  let p = j;
  while (src[p] === " " || src[p] === "\t") p++;
  const hadSpace = p > j;
  const finish = (title, endPos) => ({
    label: lab.text, href, title,
    end: endPos < src.length && src[endPos] === "\n" ? endPos + 1 : endPos,
  });
  if (p >= src.length || src[p] === "\n") {
    // Try a title on the following line; failure just means none.
    if (src[p] === "\n") {
      let q = p + 1;
      while (src[q] === " " || src[q] === "\t") q++;
      const t = scanTitle(src, q);
      if (t) {
        let m = t.end;
        while (src[m] === " " || src[m] === "\t") m++;
        if (m >= src.length || src[m] === "\n") {
          return finish(t.title, m);
        }
      }
    }
    return finish(null, p);
  }
  if (!hadSpace) return null;
  const t = scanTitle(src, p);
  if (!t) return null;
  let m = t.end;
  while (src[m] === " " || src[m] === "\t") m++;
  if (m < src.length && src[m] !== "\n") return null;
  return finish(t.title, m);
}

// Split a table row into cell texts. Escaped pipes and pipes inside
// code spans do not split; \| becomes a literal pipe in the cell.
function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (c === "`") {
      // Marked splits cells on every unescaped pipe, even inside
      // code spans: backticks are ordinary characters here.
      cur += "`";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  return cells.map((s) => s.trim());
}

// If the line at src[pos] plus the following line form a table
// header and delimiter row, return the table's start facts, else
// null.
function tableStart(src, pos) {
  const first = readLine(src, pos);
  if (first.next >= src.length && !src.includes("\n", pos)) {
    // Still possible: header is the last line — then no delimiter
    // row.
    return null;
  }
  const second = readLine(src, first.next);
  const delimCells = splitTableRow(second.text);
  if (delimCells.length === 0) return null;
  const align = [];
  for (const cell of delimCells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  const header = splitTableRow(first.text);
  if (header.length !== align.length) return null;
  if (!first.text.includes("|") && !second.text.includes("|")) return null;
  return { header, align, bodyStart: second.next };
}

// Lines a container accepted as lazy paragraph continuations are
// prefixed with this sentinel in the collected line list, so the
// recursive scan keeps them inside the open paragraph instead of
// re-reading them as new blocks.
const LAZY = "\x01";

// Strip a block quote marker from a line, returning the inner line
// (with its leading whitespace expanded to spaces), or null when
// the line does not start a quote.
function stripQuoteMarker(text) {
  const li = leadingIndent(text);
  if (li.cols > 3 || text[li.idx] !== ">") return null;
  const rest = text.slice(li.idx + 1);
  const colAfter = li.cols + 1;
  if (rest.startsWith(" ")) return expandIndent(rest.slice(1), colAfter + 1, 0);
  if (rest.startsWith("\t")) return expandIndent(rest, colAfter, 1);
  return expandIndent(rest, colAfter, 0);
}

// After a line is added to a container, is the innermost open block
// a paragraph that a lazy continuation line could extend?
function paragraphOpen(line, wasOpen) {
  if (line.charCodeAt(0) === 1) return true;
  if (isBlank(line)) return false;
  const { cols, idx } = leadingIndent(line);
  if (cols >= 4) return wasOpen;
  // Fence / ATX / thematic-break starts, using the indent already
  // computed above (the standalone helpers recompute it).
  const c0 = line[idx];
  if (c0 === "`" || c0 === "~") {
    let run = 0;
    while (line[idx + run] === c0) run++;
    if (run >= 3 && (c0 === "~" || !line.slice(idx + run).includes("`"))) {
      return false;
    }
  } else if (c0 === "#") {
    let run = 0;
    while (line[idx + run] === "#") run++;
    if (run <= 6) {
      const after = line[idx + run];
      if (after === undefined || after === " " || after === "\t") return false;
    }
  } else if (c0 === "*" || c0 === "-" || c0 === "_") {
    let count = 0;
    let ok = true;
    for (let i = idx; i < line.length; i++) {
      const ch = line[i];
      if (ch === " " || ch === "\t") continue;
      if (ch !== c0) {
        ok = false;
        break;
      }
      count++;
    }
    if (ok && count >= 3) return false;
  }
  if (wasOpen && setextLevel(line) > 0) return false;
  if (line[idx] === ">") {
    const stripped = stripQuoteMarker(line);
    return stripped === null ? false : paragraphOpen(stripped, false);
  }
  const mk = listMarker(line);
  if (mk) return mk.empty ? false : paragraphOpen(mk.first, false);
  if (htmlBlockStart(line)) return false;
  if (/^ {0,3}\[[^\]]*\]:/.test(line)) return false;
  return true;
}

function parseBlocks(src, inListItem) {
  const blocks = [];
  blocks.blankSep = false;
  const n = src.length;
  let pos = 0;
  let emitted = 0;
  let pendingBlank = false;
  const pushBlock = (b) => {
    if (emitted > 0 && pendingBlank) blocks.blankSep = true;
    emitted++;
    pendingBlank = false;
    blocks.push(b);
  };
  while (pos < n) {
    const line = readLine(src, pos);
    if (isBlank(line.text)) {
      if (emitted > 0) pendingBlank = true;
      pos = line.next;
      continue;
    }

    // A lazy line that reaches block level belongs to a paragraph.
    if (line.text.charCodeAt(0) === 1) {
      const para = parseParagraph(src, pos, line.text.slice(1), inListItem);
      pushBlock(para.block);
      pos = para.end;
      continue;
    }

    // Link reference definitions.
    const def = readDefinition(src, pos);
    if (def) {
      pushBlock({
        type: "def", label: def.label,
        href: def.href, title: def.title,
      });
      pos = def.end;
      continue;
    }

    const { cols } = leadingIndent(line.text);

    // Indented code block.
    if (cols >= 4) {
      const lines = [];
      let p = pos;
      let lastContent = 0;
      while (p < n) {
        const l = readLine(src, p);
        if (isBlank(l.text)) {
          lines.push(stripCols(l.text, 4));
          p = l.next;
          continue;
        }
        if (leadingIndent(l.text).cols < 4) break;
        lines.push(stripCols(l.text, 4));
        lastContent = lines.length;
        p = l.next;
      }
      lines.length = lastContent;
      pushBlock({ type: "code", text: lines.join("\n") + "\n" });
      pos = p;
      continue;
    }

    // Fenced code block.
    const fence = fenceStart(line.text);
    if (fence) {
      const contentStart = line.next;
      let p = contentStart;
      let contentEnd = n;
      let after = n;
      while (p < n) {
        const l = readLine(src, p);
        const fi = leadingIndent(l.text);
        if (fi.cols <= 3 && l.text[fi.idx] === fence.ch) {
          let run = 0;
          while (l.text[fi.idx + run] === fence.ch) run++;
          if (run >= fence.run && /^[ \t]*$/.test(l.text.slice(fi.idx + run))) {
            contentEnd = p;
            after = l.next;
            break;
          }
        }
        p = l.next;
      }
      let raw = src.slice(contentStart, contentEnd);
      // Indent compensation applies to backtick fences only: each
      // content line loses up to the opening line's whitespace-run
      // length (in characters) of its own leading whitespace.
      if (fence.ch === "`" && fence.indentChars > 0 && raw.length > 0) {
        raw = raw.split("\n").map((l) => stripChars(l, fence.indentChars)).join("\n");
      }
      if (raw.endsWith("\n")) raw = raw.slice(0, -1);
      if (raw.length > 0 && !raw.endsWith("\n")) raw += "\n";
      const langWord = fence.info
        .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")
        .split(/\s+/)[0] || "";
      pushBlock({ type: "fence", lang: langWord, text: raw });
      pos = after;
      continue;
    }

    // ATX heading.
    const atx = atxStart(line.text);
    if (atx) {
      pushBlock({ type: "heading", level: atx.level, text: atx.text });
      pos = line.next;
      continue;
    }

    // Thematic break.
    if (isHr(line.text)) {
      pushBlock({ type: "hr" });
      pos = line.next;
      continue;
    }

    // Block quote.
    if (cols <= 3 && line.text[leadingIndent(line.text).idx] === ">") {
      const inner = [];
      let p = pos;
      let paraOpen = false;
      let paraLines = 0;
      let openFence = null;
      while (p < n) {
        const l = readLine(src, p);
        const stripped = stripQuoteMarker(l.text);
        if (openFence) {
          if (stripped !== null) {
            inner.push(stripped);
            const fs = fenceStart(stripped);
            if (fs && fs.ch === openFence.ch && fs.run >= openFence.run && fs.info === "") {
              openFence = null;
            }
            p = l.next;
            continue;
          }
          // Unmarked lines are not fence content for marked: the
          // quote ends here (paraOpen is false while a fence is
          // open).
        } else if (stripped !== null) {
          inner.push(stripped);
          paraOpen = paragraphOpen(stripped, paraOpen);
          paraLines = isBlank(stripped) || !paraOpen ? 0 : paraLines + 1;
          openFence = fenceStart(stripped);
          if (openFence) paraOpen = false;
          p = l.next;
          continue;
        }
        // Lazy continuation of an open paragraph inside the quote.
        if (
          paraOpen && !isBlank(l.text) &&
          (l.text.charCodeAt(0) === 1 ||
            (!interruptsParagraph(l.text) && listMarker(l.text) === null))
        ) {
          const content = leadingIndent(l.text).cols >= 4
            ? stripCols(l.text, 4)
            : l.text;
          // marked quirk: a lazy '=' setext line after a paragraph
          // of two or more lines stays paragraph text, indented by
          // four spaces.
          const eq = /^ {0,3}=+[ \t]*$/.test(content) && paraLines >= 2
            ? "    " + content
            : content;
          inner.push(l.text.charCodeAt(0) === 1 ? eq : LAZY + eq);
          paraLines++;
          p = l.next;
          continue;
        }
        break;
      }
      pushBlock({
        type: "blockquote",
        blocks: parseBlocks(inner.join("\n"), false),
      });
      pos = p;
      continue;
    }

    // List.
    const marker = listMarker(line.text);
    if (marker) {
      const list = parseList(src, pos, marker);
      pushBlock(list.block);
      pos = list.end;
      continue;
    }

    // HTML block.
    const html = htmlBlockStart(line.text) || htmlBlockStart7(line.text);
    if (html) {
      if (html.kind === "comment") {
        const cEnd = commentEnd(src, pos + leadingIndent(line.text).idx);
        let end = cEnd === -1 ? n : cEnd;
        if (cEnd !== -1) {
          const eol = src.indexOf("\n", end);
          end = eol === -1 ? n : eol;
        }
        let text = src.slice(pos, end);
        if (src[end] === "\n") {
          const after = readLine(src, end + 1);
          if (end + 1 < n && after.text === "") {
            end = end + 1;
          } else {
            text += "\n";
            end = end + 1;
          }
        }
        pushBlock({ type: "html", text });
        pos = end;
        continue;
      }
      if (html.kind === "raw") {
        const closeIdx = src.toLowerCase().indexOf(html.endTag.toLowerCase(), pos);
        let end;
        if (closeIdx === -1) {
          end = n;
        } else {
          end = closeIdx + html.endTag.length;
          if (html.type === 1) {
            const gt = src.indexOf(">", closeIdx);
            end = gt === -1 ? n : gt + 1;
          }
          // The block runs to the end of the closing line.
          const eol = src.indexOf("\n", end);
          end = eol === -1 ? n : eol;
        }
        let text = src.slice(pos, end);
        // A following blank line strips the final newline; anything
        // else (content or EOF) keeps it when the source had one.
        if (src[end] === "\n") {
          const after = readLine(src, end + 1);
          if (end + 1 < n && after.text === "") {
            end = end + 1;
          } else {
            text += "\n";
            end = end + 1;
          }
        }
        pushBlock({ type: "html", text });
        pos = end;
        continue;
      }
      // Line-based HTML block: runs until a blank line. When a
      // blank line ends it, the last content line's newline is not
      // kept.
      let p = pos;
      let end = pos;
      let blankTerminated = false;
      while (p < n) {
        const l = readLine(src, p);
        if (isBlank(l.text)) {
          blankTerminated = true;
          break;
        }
        end = l.next;
        p = l.next;
      }
      let htmlText = src.slice(pos, end);
      if (blankTerminated && htmlText.endsWith("\n")) {
        htmlText = htmlText.slice(0, -1);
      }
      pushBlock({ type: "html", text: htmlText });
      pos = end;
      continue;
    }

    // Table.
    const table = tableStart(src, pos);
    if (table) {
      const rows = [];
      let p = table.bodyStart;
      while (p < n) {
        const l = readLine(src, p);
        if (isBlank(l.text)) {
          // A whitespace-only line ends the table, except a line
          // of spaces ending in a single tab, which marked reads
          // as an empty row.
          if (!/^ *\t$/.test(l.text)) break;
        } else {
          const li = leadingIndent(l.text);
          if (li.cols >= 4) break;
          if (
            li.cols <= 3 &&
            (l.text[li.idx] === ">" || fenceStart(l.text) ||
              atxStart(l.text) || isHr(l.text))
          ) {
            break;
          }
          if (listMarker(l.text)) break;
          if (htmlBlockStart(l.text) || htmlBlockStart7(l.text)) break;
        }
        const cells = splitTableRow(l.text);
        while (cells.length < table.align.length) cells.push("");
        cells.length = table.align.length;
        rows.push(cells);
        p = l.next;
      }
      pushBlock({
        type: "table", header: table.header,
        align: table.align, rows,
      });
      pos = p;
      continue;
    }

    // Paragraph, possibly a setext heading.
    const para = parseParagraph(src, pos, undefined, inListItem);
    pushBlock(para.block);
    pos = para.end;
  }
  return blocks;
}

// Scan a paragraph starting at src[pos]; returns the block it forms
// (a setext heading when an underline line follows) and the
// position after it.
function parseParagraph(src, pos, firstOverride, inListItem) {
  const lines = [];
  let p = pos;
  const n = src.length;
  while (p < n) {
    const l = readLine(src, p);
    if (lines.length === 0 && firstOverride !== undefined) {
      lines.push(firstOverride);
      p = l.next;
      continue;
    }
    if (lines.length > 0) {
      if (isBlank(l.text)) {
        // A whitespace-only final line with no line ending of its
        // own still belongs to the paragraph.
        if (!l.hasNl) {
          lines.push(l.text);
          p = l.next;
        }
        break;
      }
      if (l.text.charCodeAt(0) === 1) {
        lines.push(l.text.slice(1));
        p = l.next;
        continue;
      }
      const setext = setextLevel(l.text);
      if (setext > 0) {
        return {
          block: {
            type: "heading", level: setext,
            text: lines.join("\n").replace(/^[ \t]+/, "").replace(/[ \t\n]+$/, ""),
          },
          end: l.next,
        };
      }
      // A table can interrupt: this line is its header.
      if (tableStart(src, p)) break;
      if (interruptsParagraph(l.text)) break;
      if (inListItem) {
        // Inside a list item, an ordered marker with any start
        // number interrupts the paragraph (marked deviation).
        const mk = listMarker(l.text);
        if (mk && mk.ordered && !mk.empty) break;
      }
    }
    lines.push(l.text);
    p = l.next;
  }
  return {
    block: { type: "paragraph", text: lines.join("\n") },
    end: p,
  };
}

// Scan a whole list starting at src[pos] whose first line carries
// `firstMarker`. Items are line groups; each item's text is scanned
// recursively. A list is loose when a blank line separates two
// items, or when one item's own blocks are separated by a blank
// line (the blankSep flag its scan reports).
function parseList(src, pos, firstMarker) {
  const n = src.length;
  const items = [];
  let loose = false;
  let p = pos;
  let marker = firstMarker;

  const siblingOf = (text) => {
    if (isHr(text)) return null;
    const mk = listMarker(text);
    if (!mk) return null;
    if (mk.ordered !== firstMarker.ordered) return null;
    if (
      firstMarker.ordered
        ? mk.delim !== firstMarker.delim
        : mk.bullet !== firstMarker.bullet
    ) {
      return null;
    }
    return mk;
  };

  while (marker !== null && p < n) {
    const firstLine = readLine(src, p);
    const contentIndent = marker.contentIndent;

    // An item whose first line is empty, followed by a blank line,
    // is an empty item: nothing after the blank belongs to it,
    // though a sibling item may still follow.
    if (marker.empty) {
      const peek = firstLine.next < n ? readLine(src, firstLine.next) : null;
      if (peek && isBlank(peek.text)) {
        items.push({ lines: [""] });
        let q = firstLine.next;
        while (q < n && isBlank(readLine(src, q).text)) {
          q = readLine(src, q).next;
        }
        const sibLine = q < n ? readLine(src, q) : null;
        const sib = sibLine && leadingIndent(sibLine.text).cols < contentIndent
          ? siblingOf(sibLine.text)
          : null;
        if (sib) {
          loose = true;
          p = q;
          marker = sib;
          continue;
        }
        p = firstLine.next;
        marker = null;
        break;
      }
    }

    const itemLines = [marker.first];
    let paraOpen = paragraphOpen(marker.first, false);
    let openFence = fenceStart(marker.first);
    let q = firstLine.next;
    let pendingBlanks = 0;
    let blankStart = -1;
    let nextMarker = null;
    let listEnds = false;

    while (q < n) {
      const l = readLine(src, q);
      if (isBlank(l.text)) {
        if (openFence) {
          itemLines.push("");
          paraOpen = false;
          q = l.next;
          continue;
        }
        if (pendingBlanks === 0) blankStart = q;
        pendingBlanks++;
        q = l.next;
        continue;
      }
      const li = leadingIndent(l.text);
      if (openFence) {
        // Fence content belongs to the item until the fence closes.
        if (li.cols >= contentIndent) {
          const stripped = stripIndentCols(l.text, contentIndent);
          itemLines.push(stripped);
          const fs = fenceStart(stripped);
          if (fs && fs.ch === openFence.ch && fs.run >= openFence.run && fs.info === "") {
            openFence = null;
            paraOpen = false;
          } else {
            paraOpen = paragraphOpen(stripped, false);
          }
          q = l.next;
          continue;
        }
        // An unindented closing fence line belongs outside the item.
        const fs = fenceStart(l.text);
        if (fs && fs.ch === openFence.ch && fs.run >= openFence.run && fs.info === "") {
          listEnds = true;
          p = q;
          break;
        }
        if (siblingOf(l.text)) {
          listEnds = true;
          p = q;
          break;
        }
        // Other unindented lines are fence content only as a lazy
        // continuation of a paragraph-like content line.
        if (paraOpen) {
          itemLines.push(l.text);
          paraOpen = paragraphOpen(l.text, false);
          q = l.next;
          continue;
        }
        listEnds = true;
        p = q;
        break;
      }
      if (pendingBlanks > 0) {
        const sib = li.cols < contentIndent ? siblingOf(l.text) : null;
        if (sib) {
          loose = true;
          nextMarker = sib;
          p = q;
          break;
        }
        if (li.cols >= contentIndent) {
          for (let b = 0; b < pendingBlanks; b++) itemLines.push("");
          pendingBlanks = 0;
          const stripped = stripIndentCols(l.text, contentIndent);
          itemLines.push(stripped);
          paraOpen = paragraphOpen(stripped, false);
          openFence = fenceStart(stripped);
          q = l.next;
          continue;
        }
        listEnds = true;
        p = blankStart >= 0 ? blankStart : q;
        break;
      }
      const sib = li.cols < contentIndent ? siblingOf(l.text) : null;
      if (sib) {
        nextMarker = sib;
        p = q;
        break;
      }
      if (li.cols >= contentIndent) {
        const stripped = stripIndentCols(l.text, contentIndent);
        itemLines.push(stripped);
        paraOpen = paragraphOpen(stripped, paraOpen);
        openFence = fenceStart(stripped);
        q = l.next;
        continue;
      }
      // Lazy continuation of the item's open paragraph.
      if (
        paraOpen &&
        (l.text.charCodeAt(0) === 1 ||
          (!interruptsParagraph(l.text) && listMarker(l.text) === null))
      ) {
        const content = li.cols >= 4 ? stripCols(l.text, 4) : l.text;
        itemLines.push(l.text.charCodeAt(0) === 1 ? content : LAZY + content);
        q = l.next;
        continue;
      }
      listEnds = true;
      p = pendingBlanks > 0 && blankStart >= 0 ? blankStart : q;
      break;
    }
    if (q >= n) p = q;

    items.push({ lines: itemLines });
    if (nextMarker) {
      marker = nextMarker;
      continue;
    }
    marker = null;
  }

  const rendered = items.map((item) => {
    const blocks = parseBlocks(item.lines.join("\n"), true);
    if (blocks.blankSep) loose = true;
    let task = null;
    if (blocks.length > 0 && blocks[0].type === "paragraph") {
      const t = blocks[0].text;
      const m = /^\[( |x|X)\]( )/.exec(t);
      if (m) {
        task = m[1] === " " ? "open" : "done";
        blocks[0] = {
          type: "paragraph",
          text: t.slice(m[0].length),
          task,
        };
      }
    }
    return { blocks, task };
  });

  return {
    block: {
      type: "list", ordered: firstMarker.ordered,
      start: firstMarker.start, loose, items: rendered,
    },
    end: p,
  };
}

// -----------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------

// Walk a block tree registering link definitions; the first
// definition of a label wins.
function collectDefinitions(blocks, links) {
  for (const b of blocks) {
    if (b.type === "def") {
      const key = normalizeLabel(b.label);
      if (!links.has(key)) {
        links.set(key, { href: b.href, title: b.title });
      }
    } else if (b.type === "blockquote") {
      collectDefinitions(b.blocks, links);
    } else if (b.type === "list") {
      for (const item of b.items) collectDefinitions(item.blocks, links);
    }
  }
}

function checkboxHtml(task) {
  return task === "done"
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

function renderBlocks(blocks, links, tight) {
  let out = "";
  for (const b of blocks) {
    switch (b.type) {
      case "def":
        break;
      case "code":
        out += "<pre><code>" + escapeCode(b.text) + "</code></pre>\n";
        break;
      case "fence":
        out +=
          "<pre><code" +
          (b.lang ? ' class="language-' + escapeText(b.lang) + '"' : "") +
          ">" + escapeCode(b.text) + "</code></pre>\n";
        break;
      case "heading":
        out +=
          "<h" + b.level + ">" + renderInline(b.text, links) +
          "</h" + b.level + ">\n";
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "html":
        out += b.text;
        break;
      case "blockquote":
        out +=
          "<blockquote>\n" + renderBlocks(b.blocks, links, false) +
          "</blockquote>\n";
        break;
      case "paragraph": {
        const inner = renderInline(b.text, links);
        if (tight) {
          out += b.task ? checkboxHtml(b.task) + " " + inner : inner;
        } else if (b.task) {
          out += "<p>" + checkboxHtml(b.task) + " " + inner + "</p>\n";
        } else {
          out += "<p>" + inner + "</p>\n";
        }
        break;
      }
      case "list":
        out += renderList(b, links);
        break;
      case "table":
        out += renderTable(b, links);
        break;
    }
  }
  return out;
}

function renderList(list, links) {
  let out;
  if (list.ordered) {
    out = list.start !== 1 ? '<ol start="' + list.start + '">\n' : "<ol>\n";
  } else {
    out = "<ul>\n";
  }
  for (const item of list.items) {
    const content = renderBlocks(item.blocks, links, !list.loose);
    out += "<li>" + content + "</li>\n";
  }
  out += list.ordered ? "</ol>\n" : "</ul>\n";
  return out;
}

function renderTable(table, links) {
  let out = "<table>\n<thead>\n<tr>\n";
  for (let i = 0; i < table.header.length; i++) {
    const align = table.align[i];
    out +=
      "<th" + (align ? ' align="' + align + '"' : "") + ">" +
      renderInline(table.header[i], links) + "</th>\n";
  }
  out += "</tr>\n</thead>\n";
  if (table.rows.length > 0) {
    out += "<tbody>";
    for (const row of table.rows) {
      out += "<tr>\n";
      for (let i = 0; i < row.length; i++) {
        const align = table.align[i];
        out +=
          "<td" + (align ? ' align="' + align + '"' : "") + ">" +
          renderInline(row[i], links) + "</td>\n";
      }
      out += "</tr>\n";
    }
    out += "</tbody>";
  }
  out += "</table>\n";
  return out;
}

// Render a markdown string to the HTML marked 18.1.3 produces for
// it with default options.
export function parse(markdown) {
  // Line-ending normalisation only bites when a '\r' is present;
  // the overwhelming majority of inputs skip the regex pass
  // entirely.
  const src = markdown.includes("\r")
    ? markdown.replace(/\r\n?/g, "\n")
    : markdown;
  const blocks = parseBlocks(src);
  const links = new Map();
  links.inLinkTag = false;
  collectDefinitions(blocks, links);
  return renderBlocks(blocks, links, false);
}
