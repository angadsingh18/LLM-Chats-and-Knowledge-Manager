import type { RawCapture } from "@ai-manager/provider-adapters";

/**
 * MV3 service worker. It can be terminated at any time, so it keeps NO state in
 * memory: captures are queued in IndexedDB (pending) and flushed to the API.
 */
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: { type: string; capture?: RawCapture }, _sender, sendResponse) => {
    if (msg.type === "capture" && msg.capture) {
      // TODO(step: extension-sync): persist to IndexedDB queue, then POST /v1/ingest/captures.
      console.debug("[ai-manager] capture received", msg.capture.providerId);
      sendResponse({ queued: true });
    }
    return false;
  });

  // Retry timer for the offline queue (alarms survive service-worker restarts).
  chrome.alarms.create("flush-queue", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "flush-queue") {
      // TODO: flush pending captures with backoff.
    }
  });
});
