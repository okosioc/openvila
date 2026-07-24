import assert from "node:assert/strict";
import test from "node:test";
import { extractHtmlLinks, stripHtml } from "../../src/utils/net.js";

test("HTML extraction keeps safe anchors in a separate link index", () => {
  const html = '<p>Read <a href="/guide?source=faq&amp;lang=en"><strong>the guide</strong></a> and <a href="https://example.com/pricing">pricing</a>.</p>';

  assert.deepEqual(extractHtmlLinks(html), [
    { text: "the guide", url: "/guide?source=faq&lang=en" },
    { text: "pricing", url: "https://example.com/pricing" },
  ]);
  assert.equal(stripHtml(html), "Read the guide and pricing .");
});

test("HTML extraction does not preserve unsafe anchor protocols", () => {
  const html = '<p><a href="javascript:alert(1)">Unsafe</a> <a href="mailto:support@example.com">Email</a></p>';

  assert.deepEqual(extractHtmlLinks(html), []);
  assert.equal(stripHtml(html), "Unsafe Email");
});
