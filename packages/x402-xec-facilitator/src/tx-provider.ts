import {
  TxNotFoundError,
  type ChronikTransaction,
  type ChronikTxProvider,
} from "@x402-xec/core";

export {
  TxNotFoundError,
  type ChronikTxProvider,
  type TxProvider,
} from "@x402-xec/core";

/** Deterministic Chronik-shaped provider backed only by local fixture data. */
export class FixtureChronikTxProvider implements ChronikTxProvider {
  readonly #transactions = new Map<string, ChronikTransaction>();

  constructor(transactions: readonly ChronikTransaction[] = []) {
    for (const transaction of transactions) this.addTransaction(transaction);
  }

  addTransaction(transaction: ChronikTransaction): void {
    this.#transactions.set(transaction.txid, transaction);
  }

  async getTx(txid: string): Promise<ChronikTransaction> {
    const transaction = this.#transactions.get(txid);
    if (!transaction) throw new TxNotFoundError(txid);
    return transaction;
  }
}
