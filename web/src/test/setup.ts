import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";
import { handlers } from "../lib/indexer/msw/handlers";

// Global MSW server for every test file: any indexer-client test can just
// import `fetchTokens`/etc. and rely on these fixtures without redeclaring
// its own `setupServer` boilerplate. `onUnhandledRequest: "bypass"` (not
// "error") here — unrelated existing tests (e.g. RainbowKit/WalletConnect
// init in ConnectButton.test.tsx) may issue requests this indexer mock knows
// nothing about, and this global server must not start failing them. A test
// that wants strict "every request must be mocked" behavior (see
// client.test.ts) opts into that itself via its own local server.
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
