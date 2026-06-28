import type { NonceStore } from "@x402-xec/core";

export interface FundingAccount {
  readonly fundingOutpoint: { readonly txid: string; readonly outIdx: number };
  readonly payer: string;
  readonly fundingValueSats: bigint;
  remainingBalanceSats: bigint;
}

export interface LedgerEntry {
  readonly fundingOutpoint: { readonly txid: string; readonly outIdx: number };
  readonly payer: string;
  readonly payTo: string;
  readonly fundingValueSats: bigint;
  readonly remainingBalanceSats: bigint;
  readonly debitedSats: bigint;
  readonly invoiceId: string;
  readonly nonce: string;
  readonly authorizationDigest: string;
  readonly idempotencyKey: string;
}

export type StoredResponse = Readonly<Record<string, unknown>>;

interface IdempotencyRecord {
  readonly requestDigest: string;
  readonly response: StoredResponse;
}

export interface LedgerTransaction {
  readonly nonceStore: NonceStore;
  findIdempotent(key: string): IdempotencyRecord | undefined;
  getFundingAccount(txid: string, outIdx: number): FundingAccount | undefined;
  commit(input: {
    readonly account: FundingAccount;
    readonly entry: LedgerEntry;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly response: StoredResponse;
  }): void;
}

export class InMemoryTransactionalLedger {
  readonly #accounts = new Map<string, FundingAccount>();
  readonly #entries: LedgerEntry[] = [];
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #nonces = new Map<string, number>();
  #tail: Promise<void> = Promise.resolve();

  async transact<T>(operation: (transaction: LedgerTransaction) => Promise<T>): Promise<T> {
    let release = (): void => undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    const stagedNonces = new Map<string, number>();
    const transaction: LedgerTransaction = {
      nonceStore: {
        consume: async (nonce, expiresAt, now) => {
          for (const [key, expiry] of this.#nonces) {
            if (expiry <= now) this.#nonces.delete(key);
          }
          if (this.#nonces.has(nonce) || stagedNonces.has(nonce)) return false;
          stagedNonces.set(nonce, expiresAt);
          return true;
        },
      },
      findIdempotent: (key) => this.#idempotency.get(key),
      getFundingAccount: (txid, outIdx) => this.#accounts.get(outpointKey(txid, outIdx)),
      commit: ({ account, entry, idempotencyKey, requestDigest, response }) => {
        for (const [nonce, expiresAt] of stagedNonces) this.#nonces.set(nonce, expiresAt);
        this.#accounts.set(
          outpointKey(account.fundingOutpoint.txid, account.fundingOutpoint.outIdx),
          account,
        );
        this.#entries.push(entry);
        this.#idempotency.set(idempotencyKey, { requestDigest, response });
      },
    };

    try {
      return await operation(transaction);
    } finally {
      release();
    }
  }

  entries(): readonly LedgerEntry[] {
    return this.#entries.map((entry) => ({
      ...entry,
      fundingOutpoint: { ...entry.fundingOutpoint },
    }));
  }
}

const outpointKey = (txid: string, outIdx: number): string => `${txid}:${outIdx}`;
