import type { PageAdapter } from "@ai-manager/provider-adapters";

/**
 * Generic content-script runtime: watches the page for changes, debounces, runs the
 * provider adapter and sends any capture to the service worker. Never throws into the page.
 */
export function runAdapter(adapter: PageAdapter, debounceMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const capture = () => {
    try {
      const raw = adapter.extractConversation(document);
      if (raw) chrome.runtime.sendMessage({ type: "capture", capture: raw });
    } catch (e) {
      console.debug("[ai-manager] adapter error", adapter.providerId, e);
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(capture, debounceMs); // wait for streaming to settle
  });
  observer.observe(document.body, { childList: true, subtree: true });
  timer = setTimeout(capture, debounceMs);
}
