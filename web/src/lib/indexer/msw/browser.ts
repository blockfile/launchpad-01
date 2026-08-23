import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

/**
 * Browser-side MSW worker for DEV ONLY, so a plain `npm run dev` shows
 * Explore/Trade/Portfolio populated from the same fixtures the vitest node
 * setup uses (`./handlers`) — no running indexer required. Started lazily from
 * `main.tsx` behind an `import.meta.env.DEV` guard, so this module (and msw's
 * browser build) is dead-code-eliminated from production bundles and never
 * touches the vitest `msw/node` setup.
 */
export const worker = setupWorker(...handlers);
