import assert from "node:assert/strict";
import test from "node:test";
import { htmlAnchorsToMarkdown, stripHtml } from "../../src/utils/net.js";

test("HTML extraction preserves safe anchors as Markdown links", () => {
  const html = '<p>Read <a href="/guide?source=faq&amp;lang=en"><strong>the guide</strong></a> and <a href="https://example.com/pricing">pricing</a>.</p>';

  assert.equal(
    htmlAnchorsToMarkdown(html),
    '<p>Read [the guide](/guide?source=faq&lang=en) and [pricing](https://example.com/pricing).</p>',
  );
  assert.equal(stripHtml(html), "Read [the guide](/guide?source=faq&lang=en) and [pricing](https://example.com/pricing).",);
});

test("HTML extraction does not preserve unsafe anchor protocols", () => {
  const html = '<p><a href="javascript:alert(1)">Unsafe</a> <a href="mailto:support@example.com">Email</a></p>';

  assert.equal(stripHtml(html), "Unsafe Email");
});
