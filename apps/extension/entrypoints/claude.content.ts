import { runAdapter } from "../lib/runAdapter";
import { claudeAdapter } from "../adapters/claude";

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  runAt: "document_idle",
  main() {
    runAdapter(claudeAdapter);
  },
});
