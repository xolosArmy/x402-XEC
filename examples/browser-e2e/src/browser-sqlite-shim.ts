/** Minimal browser build alias for node:sqlite usage in @x402-xec/core. */
export class DatabaseSync {
  constructor() {
    throw new Error("Sqlite is not available in browser environments");
  }
}
