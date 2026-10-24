import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEmailSnippet } from "@/lib/email-text";

test("decodes HTML character references in Gmail snippets", () => {
  assert.equal(decodeEmailSnippet("Let&#39;s play cricket today"), "Let's play cricket today");
  assert.equal(decodeEmailSnippet("Tom &amp; Jerry &mdash; hello"), "Tom & Jerry — hello");
});

test("decodes a snippet only once", () => {
  assert.equal(decodeEmailSnippet("Show &amp;#39; as text"), "Show &#39; as text");
});
