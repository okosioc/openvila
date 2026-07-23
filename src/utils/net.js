function unique(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim().length > 0))];
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlAnchorHref(attributes) {
  const matched = String(attributes || "").match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  const href = decodeHtmlEntities(matched?.[1] || matched?.[2] || matched?.[3] || "").trim();
  if (!href || /\s/.test(href) || /^(?:javascript|data|vbscript):/i.test(href)) {
    return "";
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) {
    return "";
  }
  return href;
}

function htmlAnchorLabel(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function htmlAnchorsToMarkdown(html) {
  return String(html || "").replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (match, attributes, content) => {
    const href = htmlAnchorHref(attributes);
    const label = htmlAnchorLabel(content);
    if (!href || !label) {
      return label;
    }
    return `[${label}](${href})`;
  });
}

export async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function parseSitemapLocs(xmlText) {
  const text = String(xmlText || "");
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let match = re.exec(text);
  while (match) {
    const value = String(match[1] || "").trim();
    if (value) {
      urls.push(value);
    }
    match = re.exec(text);
  }
  return unique(urls);
}

export function stripHtml(html) {
  return decodeHtmlEntities(
    htmlAnchorsToMarkdown(
      String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " "),
    )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
