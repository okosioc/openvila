export function detectLocaleFromEnv() {
  const lang = process.env.OPENVILA_LANG || process.env.LANG || "en";
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function pick(locale, zhText, enText) {
  return locale === "zh-CN" ? zhText : enText;
}
