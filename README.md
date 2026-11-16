[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/labibhanafi/markdown-render-speed-02-entry-v9/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/labibhanafi/markdown-render-speed-02-entry-v9/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# Faster Markdown rendering, byte-identical to marked

A dependency-free JavaScript Markdown renderer whose `parse(markdown)`
returns, for every input, exactly the HTML that **marked 18.1.3** returns
with its default options (GFM on, breaks off, pedantic off) — only faster.
Where marked departs from the CommonMark/GFM specifications, marked's
output is the target.

Entry for the [make.fun](https://make.fun) bounty
[markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02)
("Make Markdown rendering faster", $250 USDC).

- `parse.js` — the module. `parse(markdown)` is the drop-in replacement.
- `main.ts` — the harness program: reads every case from
  `/input/cases.json`, renders each with `parse`, writes
  `/output/html.json`.

## How it works

The renderer is a fresh implementation built around the same grammar
marked uses. A block phase scans the source line by line — blank
separators, indented and fenced code, ATX and setext headings, thematic
breaks, block quotes, lists, HTML blocks, link reference definitions,
GFM tables, paragraphs — collecting link definitions on the way, so
forward references resolve. An inline phase then renders each block's
text with a bracket stack for links and images, and a delimiter-run
emphasis engine that reproduces marked's model faithfully: opening runs
are classified by their neighbouring characters, candidate closers are
classified into opener-like, plain and both-flanking runs with the
rule-of-three accounting, and the scan runs over a masked copy of the
text in which code spans, link spans, HTML tags, defined reference
links and backslash escapes are blanked out, so delimiters inside them
never take part in a match.

The speed comes from the mechanics around that grammar:

- plain text is consumed in bulk: one search finds the next position
  where any inline rule could start, instead of dispatching per
  character;
- the emphasis mask and the closer-position tables are only computed
  for text that actually contains a delimiter character, and each
  masking step is skipped when its trigger characters are absent;
- extended autolinks sit behind a cheap prefix gate, so ordinary words
  never pay for a URL match attempt;
- bracket scans that decide whether a link forms are cached per
  bracket instead of being recomputed for every delimiter run and
  code span inside the link text;
- emphasis and strikethrough closer searches use native index scans
  rather than per-character loops, and emphasis content skips are
  anchored with sticky patterns instead of slicing the remaining text;
- text nodes that need no escaping render without an escaping pass,
  and inputs without a carriage return skip the line-ending
  normalisation pass entirely.

## Verification

Against the competition's practice set (652 CommonMark examples, 28 GFM
extension examples, 40 generated documents of 20K–110K characters), the
output is byte-identical to marked 18.1.3 on all 720 cases — verified
repeatedly, including with the case order shuffled to rule out any
cross-case state, and end-to-end through `main.ts` (the produced
`html.json` matches the reference array exactly). In local benchmarks
over the same set (in-process against the kit's vendored marked
baseline, warm-up plus interleaved rounds over the full 720 cases, CPU
time), this renderer runs about 1.2× faster than the marked baseline
(median ratios of 1.15×–1.40× across repeated runs on this machine).

## NOTICE

The Markdown grammar implemented in `parse.js` is the grammar of the
marked project (https://github.com/markedjs/marked), re-implemented in
a new engine written for this competition. marked is Copyright (c)
2011-2026, Christopher Jeffrey and Copyright (c) 2016-2026, the marked
contributors, and is licensed under the MIT License. This repository's
own code is under the MIT License in `LICENSE`.
