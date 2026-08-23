/** Chain ids the app is wired for, in a deliberately wagmi-free module.
 *
 * UI components (the wrong-network guidance) need these ids but must NOT pull in
 * `./wagmi`, whose top-level `getDefaultConfig` / `http()` call runs at import
 * time and throws in any test that mocks the whole "wagmi" module (no `http`
 * export). Keeping the ids here lets both `./wagmi` and those components share
 * one source of truth without that import-time hazard. */
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

/** The set a connected wallet must be on for the app's reads/writes to work. */
export const SUPPORTED_CHAIN_IDS: readonly number[] = [
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
];
