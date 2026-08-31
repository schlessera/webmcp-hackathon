/**
 * Gate 5 reload policy. Chromium participants auto-reload silently on
 * build/contract changes. The ChatGPT in-app browser was verified empirically
 * (manual gate step 9, 2026-08-31): after a programmatic reload, Available
 * site tools repopulates and the session identity survives (sessionStorage,
 * with the fragment re-exchange as fallback) — so ?surface=chatgpt now
 * reloads silently too. Only genuinely unknown non-Chromium surfaces keep the
 * "protocol updated — tap to refresh" banner.
 */
export function reloadIsProvenSafe(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("surface") === "chatgpt") return true;
  const ua = navigator.userAgent;
  const isChromium = /Chrom(e|ium)\//.test(ua);
  const isKnownAutomation =
    /Playwright|HeadlessChrome/.test(ua) || navigator.webdriver === true;
  return isChromium || isKnownAutomation;
}
