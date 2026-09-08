import { useSyncExternalStore } from "react";
import { diagnostics, type DiagnosticsState } from "../diagnostics-store.ts";

type SupportState = DiagnosticsState["registration"] | "shim";

const messages = {
  pending: {
    title: "Checking WebMCP in this browser…",
    detail: "Waiting for the browser to make this page’s tools available.",
  },
  registered: {
    title: "WebMCP detected in this browser",
    detail: "Spokes has registered its tools. You’ll still need a compatible agent to use them.",
  },
  unsupported: {
    title: "WebMCP not detected",
    detail: "This browser isn’t exposing WebMCP to this page. You can still use Spokes without an external agent.",
  },
  failed: {
    title: "WebMCP detected, but not ready",
    detail: "This page couldn’t register its tools. Try reloading, or check the browser requirements below.",
  },
  shim: {
    title: "Test mode · browser support unverified",
    detail: "A test helper is providing WebMCP on this page. Browser support hasn’t been confirmed.",
  },
} satisfies Record<SupportState, { title: string; detail: string }>;

const subscribe = (listener: () => void) => diagnostics.subscribe(listener);
function getSupportState(): SupportState {
  // The opt-in test shim must never count as evidence of browser support.
  if ((window as unknown as { __webmcpTestShim?: unknown }).__webmcpTestShim) return "shim";
  return diagnostics.state.registration;
}

/** Observe the app's real registration result without registering probe tools. */
export function useBrowserSupportState() {
  return useSyncExternalStore(subscribe, getSupportState);
}

export function BrowserSupportCheck() {
  const state = useBrowserSupportState();
  const { title, detail } = messages[state];
  return (
    <div className="ld-browser-check" data-state={state} data-testid="browser-support-check">
      <div className="ld-browser-result" role="status" aria-live="polite" aria-atomic="true">
        <svg className="ld-browser-icon" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="6" width="34" height="28" rx="4" />
          <path d="M3 13h34" />
          {state === "registered" ? <path d="m13 24 5 5 10-10" />
            : state === "failed" ? <><path d="M20 19v5" /><circle cx="20" cy="28" r="1" fill="currentColor" stroke="none" /></>
            : state === "pending" ? <><circle cx="14" cy="24" r="1" /><circle cx="20" cy="24" r="1" /><circle cx="26" cy="24" r="1" /></>
            : <path d="M14 24h12" strokeDasharray={state === "shim" ? "2 4" : undefined} />}
        </svg>
        <div>
          <strong className="ld-browser-title">{title}</strong>
          <p>{detail}</p>
        </div>
      </div>
      <a href="https://developer.chrome.com/docs/ai/webmcp">Check browser requirements</a>
    </div>
  );
}
