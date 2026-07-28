function unique(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim().length > 0))];
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
