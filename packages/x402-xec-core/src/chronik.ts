export interface FundingOutpoint {
  readonly txid: string;
  readonly outIdx: number;
}

export interface ChronikBlock {
  readonly height: number;
  readonly hash: string;
  readonly timestamp: number;
}

export interface ChronikToken {
  readonly tokenId: string;
  readonly atoms: bigint;
  readonly isMintBaton: boolean;
}

export interface ChronikTransactionOutput {
  readonly sats: bigint;
  readonly outputScript: string;
  readonly token?: ChronikToken;
}

/**
 * The read-only subset of a Chronik transaction needed to inspect XEC funding.
 * `block` is present for a confirmed transaction. Chronik's Avalanche finality
 * signal can independently make an unconfirmed transaction acceptable.
 */
export interface ChronikTransaction {
  readonly txid: string;
  readonly outputs: readonly ChronikTransactionOutput[];
  readonly block?: ChronikBlock;
  readonly isFinal: boolean;
}

/** Read-only transaction boundary. Implementations must not return `null`. */
export interface TxProvider {
  getTx(txid: string): Promise<ChronikTransaction>;
}

/** Marker interface for providers backed by Chronik-shaped transaction data. */
export interface ChronikTxProvider extends TxProvider {}

/** Typed provider failure used when a transaction does not exist. */
export class TxNotFoundError extends Error {
  readonly code = "TX_NOT_FOUND";
  readonly txid: string;

  constructor(txid: string) {
    super(`Transaction not found: ${txid}`);
    this.name = "TxNotFoundError";
    this.txid = txid;
  }
}

/** @deprecated Use `TxProvider`; retained for source compatibility. */
export interface ChronikClient {
  getTransaction(txid: string): Promise<ChronikTransaction | null>;
}

export type FundingInspectionFailureCode =
  | "TRANSACTION_NOT_FOUND"
  | "OUTPUT_NOT_FOUND"
  | "OUTPUT_SCRIPT_MISMATCH"
  | "INSUFFICIENT_SATS"
  | "TOKEN_OUTPUT"
  | "TRANSACTION_NOT_FINAL";

export type FundingInspectionResult =
  | {
    readonly ok: true;
    readonly transaction: ChronikTransaction;
    readonly output: ChronikTransactionOutput;
  }
  | { readonly ok: false; readonly code: FundingInspectionFailureCode };

interface InspectFundingTransactionBaseInput {
  readonly fundingOutpoint: FundingOutpoint;
  /** Expected locking script; omit only when no address-to-script codec exists. */
  readonly outputScript?: string;
  readonly amountSats: bigint;
}

export type InspectFundingTransactionInput =
  | (InspectFundingTransactionBaseInput & {
    readonly txProvider: TxProvider;
    readonly chronik?: never;
  })
  | (InspectFundingTransactionBaseInput & {
    /** @deprecated Use `txProvider`. */
    readonly chronik: ChronikClient;
    readonly txProvider?: never;
  });

/**
 * Inspects a payment output through the injected read-only transaction boundary.
 * The helper performs no network setup and cannot construct or broadcast a tx.
 */
export async function inspectFundingTransaction(
  input: InspectFundingTransactionInput,
): Promise<FundingInspectionResult> {
  let transaction: ChronikTransaction | null;
  try {
    transaction = input.txProvider
      ? await input.txProvider.getTx(input.fundingOutpoint.txid)
      : await input.chronik.getTransaction(input.fundingOutpoint.txid);
  } catch (error) {
    if (error instanceof TxNotFoundError) {
      return { ok: false, code: "TRANSACTION_NOT_FOUND" };
    }
    throw error;
  }
  if (!transaction || transaction.txid !== input.fundingOutpoint.txid) {
    return { ok: false, code: "TRANSACTION_NOT_FOUND" };
  }

  const output = transaction.outputs[input.fundingOutpoint.outIdx];
  if (!output) return { ok: false, code: "OUTPUT_NOT_FOUND" };
  if (input.outputScript !== undefined && output.outputScript !== input.outputScript) {
    return { ok: false, code: "OUTPUT_SCRIPT_MISMATCH" };
  }
  if (output.sats < input.amountSats) {
    return { ok: false, code: "INSUFFICIENT_SATS" };
  }
  if (output.token !== undefined) {
    return { ok: false, code: "TOKEN_OUTPUT" };
  }
  if (transaction.block === undefined && transaction.isFinal !== true) {
    return { ok: false, code: "TRANSACTION_NOT_FINAL" };
  }

  return { ok: true, transaction, output };
}
