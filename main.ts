// main.ts — the program the make.fun harness runs as
// `node /bot/main.ts` on Node 22.
//
// It reads the whole case set from /input/cases.json (an array of
// { id, markdown } objects), renders every markdown string on its
// own through parse() from ./parse.js, and writes the HTML strings,
// in exactly the same order, as a JSON array to /output/html.json.
//
// parse() holds no state between calls, so rendering the cases in
// file order cannot change any single result, and running the same
// input twice produces byte-identical output. For local runs the
// two directories can be redirected with MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR, which is how the practice set is checked
// without the grading container.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// The harness always provides /output, but creating it when absent
// makes local runs behave the same way instead of failing on the
// final write. Each case is rendered on its own: parse() keeps no
// state between calls, so the order of the cases cannot change any
// single result, and the output array preserves the input order.
mkdirSync(outputDir, { recursive: true });

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(
  readFileSync(join(inputDir, "cases.json"), "utf8"),
);

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
