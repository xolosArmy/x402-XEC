import type { ChronikClient, ChronikTransaction } from "@x402-xec/core";

/** Deterministic, process-local Chronik replacement. It performs no network I/O. */
export class MockChronik implements ChronikClient {
  readonly #transactions = new Map<string, ChronikTransaction>();

  constructor(transactions: readonly ChronikTransaction[] = []) {
    for (const transaction of transactions) this.addTransaction(transaction);
  }

  addTransaction(transaction: ChronikTransaction): void {
    this.#transactions.set(transaction.txid, transaction);
  }

  async getTransaction(txid: string): Promise<ChronikTransaction | null> {
    return this.#transactions.get(txid) ?? null;
  }
}
