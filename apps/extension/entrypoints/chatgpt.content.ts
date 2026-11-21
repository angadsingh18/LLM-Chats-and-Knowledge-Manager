import { runAdapter } from "../lib/runAdapter";
import { chatgptAdapter } from "../adapters/chatgpt";

// One content script per provider, loaded only on that provider's hosts.
export default defineContentScript({
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  runAt: "document_idle",
  main() {
    runAdapter(chatgptAdapter);
  },
});
