import {
  TxNotFoundError,
  type ChronikClient,
  type ChronikTransaction,
} from "@x402-xec/core";
import { FixtureChronikTxProvider } from "./tx-provider.js";

/** @deprecated Use `FixtureChronikTxProvider`. */
export class MockChronik extends FixtureChronikTxProvider implements ChronikClient {
  async getTransaction(txid: string): Promise<ChronikTransaction | null> {
    try {
      return await this.getTx(txid);
    } catch (error) {
      if (error instanceof TxNotFoundError) return null;
      throw error;
    }
  }
}
