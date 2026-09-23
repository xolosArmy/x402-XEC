/**
 * @file settlement-verifier.ts
 *
 * Gate C3B Server-Authoritative Settlement Proof Verification & Resource Unlock.
 */

import { cashAddressToOutputScriptHex, decodeCashAddress } from "./cashaddr.js";
import {
  isValidChronikBlock,
  TxNotFoundError,
  type ChronikTransaction,
  type TxProvider,
} from "./chronik.js";
import type { AuthoritativeInvoiceRecord, AuthoritativeInvoiceStore } from "./invoice-store.js";
import { computeResourceHash, type ResourceRequest } from "./resource.js";
import {
  x402SettlementProofV1Schema,
  X402_VERSION,
  XEC_MAINNET,
  type X402SettlementProofV1,
} from "./schemas.js";

export type ChronikQueryTarget =
  | TxProvider
  | { getTx: (txid: string) => Promise<ChronikTransaction> }
  | { tx: (txid: string) => Promise<ChronikTransaction> };

export interface VerifySettlementProofOptions {
  /** Untrusted proof supplied by caller */
  readonly proof: unknown;
  /** Server's authoritative invoice store */
  readonly store: AuthoritativeInvoiceStore;
  /** Server-owned Chronik client or transaction provider */
  readonly txProvider: ChronikQueryTarget;
  /** Optional caller-expected resource to enforce exact resource matching */
  readonly expectedResource?: ResourceRequest | undefined;
  /** Injectable clock provider for deterministic testing (seconds since epoch) */
  readonly now?: (() => number) | undefined;
  /** Optional custom address-to-script converter */
  readonly addressToScript?: ((address: string) => string) | undefined;
}

export const TEMPORAL_FENCE_TOLERANCE_SECONDS = 10;

export type SettlementVerificationErrorCode =
  | "MALFORMED_PROOF"
  | "INVOICE_NOT_FOUND"
  | "RESOURCE_MISMATCH"
  | "NETWORK_MISMATCH"
  | "VERSION_MISMATCH"
  | "INVOICE_EXPIRED"
  | "INVOICE_NOT_YET_VALID"
  | "INVALID_SERVER_TIME"
  | "TX_NOT_FOUND"
  | "TRANSACTION_NOT_FINAL"
  | "TRANSACTION_TIME_UNKNOWN"
  | "HISTORICAL_TRANSACTION"
  | "PAY_TO_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "TOKEN_OUTPUT_DISALLOWED"
  | "OUTPUT_NOT_FOUND"
  | "TXID_CONFLICT"
  | "TXID_REUSED"
  | "CHRONIK_UNAVAILABLE"
  | "MALFORMED_CHRONIK_TX";

export type SettlementVerificationSuccess = {
  readonly ok: true;
  readonly status: "UNLOCKED";
  readonly invoice: AuthoritativeInvoiceRecord;
  readonly proof: X402SettlementProofV1;
  readonly matchedOutputIndex: number;
  readonly transaction: ChronikTransaction;
  readonly idempotent: boolean;
};

export type SettlementVerificationFailure = {
  readonly ok: false;
  readonly httpStatus: number;
  readonly code: SettlementVerificationErrorCode;
  readonly message: string;
};

export type SettlementVerificationResult =
  | SettlementVerificationSuccess
  | SettlementVerificationFailure;

/**
 * Independently queries the server-owned Chronik provider.
 */
async function fetchChronikTx(
  target: ChronikQueryTarget,
  txid: string,
): Promise<ChronikTransaction> {
  if ("getTx" in target && typeof target.getTx === "function") {
    return target.getTx(txid);
  }
  if ("tx" in target && typeof target.tx === "function") {
    return target.tx(txid);
  }
  throw new Error("Supplied txProvider does not expose getTx or tx method");
}

/**
 * Validates a C3B settlement proof against server-authoritative state and
 * independent on-chain Chronik observation.
 *
 * Enforces:
 * 1. Proof schema validation (narrow, no client-selected vout, no signatures).
 * 2. Authoritative server-issued invoice lookup (fails if not issued by this server).
 * 3. Resource, network, and validity window validation.
 * 4. Independent Chronik query (fail-closed on error or malformed response).
 * 5. Exact payment output matching derived by the server (never client-nominated).
 * 6. Atomic commit with (invoiceHash, txid) idempotency and replay protection.
 */
export async function verifySettlementProof(
  options: VerifySettlementProofOptions,
): Promise<SettlementVerificationResult> {
  // 1. Validate proof schema
  const parsedProof = x402SettlementProofV1Schema.safeParse(options.proof);
  if (!parsedProof.success) {
    return {
      ok: false,
      httpStatus: 400,
      code: "MALFORMED_PROOF",
      message: parsedProof.error.message,
    };
  }
  const proof = parsedProof.data;

  // 2. Load authoritative server-issued invoice by invoiceHash
  const invoice = await options.store.getByInvoiceHash(proof.invoiceHash);
  if (!invoice) {
    return {
      ok: false,
      httpStatus: 402,
      code: "INVOICE_NOT_FOUND",
      message: `Invoice ${proof.invoiceHash} was not issued by this server`,
    };
  }

  // 3. Validate network and version
  if (invoice.network !== XEC_MAINNET || proof.network !== XEC_MAINNET) {
    return {
      ok: false,
      httpStatus: 400,
      code: "NETWORK_MISMATCH",
      message: `Expected network ${XEC_MAINNET}`,
    };
  }

  if (proof.x402Version !== X402_VERSION) {
    return {
      ok: false,
      httpStatus: 400,
      code: "VERSION_MISMATCH",
      message: `Expected x402Version ${X402_VERSION}`,
    };
  }

  // 4. Validate resource binding if expectedResource is provided
  if (options.expectedResource) {
    const expectedResourceHash = computeResourceHash(options.expectedResource);
    if (expectedResourceHash !== invoice.resourceHash) {
      return {
        ok: false,
        httpStatus: 400,
        code: "RESOURCE_MISMATCH",
        message: "Invoice was issued for a different resource",
      };
    }
  }

  // 5. Validate temporal bounds
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
    return {
      ok: false,
      httpStatus: 500,
      code: "INVALID_SERVER_TIME",
      message: "Server clock returned an invalid Unix timestamp",
    };
  }
  if (now < invoice.issuedAt) {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVOICE_NOT_YET_VALID",
      message: "Invoice is not yet valid",
    };
  }

  // If already paid with this exact txid: idempotent retry succeeds even past expiry
  const isIdempotentRetry =
    invoice.state === "PAID" && invoice.settledTxid === proof.txid;

  if (!isIdempotentRetry && invoice.state !== "PAID" && now >= invoice.expiresAt) {
    return {
      ok: false,
      httpStatus: 402,
      code: "INVOICE_EXPIRED",
      message: "Invoice has expired",
    };
  }

  // Conflict check if already paid with a different txid
  if (invoice.state === "PAID" && invoice.settledTxid !== proof.txid) {
    return {
      ok: false,
      httpStatus: 409,
      code: "TXID_CONFLICT",
      message: `Invoice ${proof.invoiceHash} has already been paid with a different transaction`,
    };
  }

  // 6. Independently query SERVER-OWNED Chronik
  let tx: ChronikTransaction;
  try {
    tx = await fetchChronikTx(options.txProvider, proof.txid);
  } catch (error) {
    if (
      error instanceof TxNotFoundError ||
      (typeof error === "object" && error !== null && (error as any).code === "TX_NOT_FOUND")
    ) {
      return {
        ok: false,
        httpStatus: 402,
        code: "TX_NOT_FOUND",
        message: `Transaction ${proof.txid} was not found on chain`,
      };
    }

    // Fail closed as verifier unavailable (5xx)
    return {
      ok: false,
      httpStatus: 502,
      code: "CHRONIK_UNAVAILABLE",
      message: `Chronik query failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 7. Validate transaction integrity
  if (
    !tx ||
    typeof tx !== "object" ||
    typeof tx.txid !== "string" ||
    !Array.isArray(tx.outputs)
  ) {
    return {
      ok: false,
      httpStatus: 502,
      code: "MALFORMED_CHRONIK_TX",
      message: "Chronik returned malformed transaction data",
    };
  }

  if (tx.txid.toLowerCase() !== proof.txid.toLowerCase()) {
    return {
      ok: false,
      httpStatus: 502,
      code: "MALFORMED_CHRONIK_TX",
      message: "Chronik returned transaction with mismatched txid",
    };
  }

  // 8. Enforce confirmation or Avalanche-finality with strict shape validation
  if (typeof (tx as any).isFinal !== "boolean") {
    return {
      ok: false,
      httpStatus: 502,
      code: "MALFORMED_CHRONIK_TX",
      message: "Chronik returned non-boolean isFinal field",
    };
  }

  let validConfirmedBlock = false;
  if (tx.block !== undefined) {
    if (!isValidChronikBlock(tx.block)) {
      return {
        ok: false,
        httpStatus: 502,
        code: "MALFORMED_CHRONIK_TX",
        message: "Chronik returned malformed confirmed block structure",
      };
    }
    validConfirmedBlock = true;
  }

  // 8b. Validate the required Chronik timeFirstSeen field before making any
  // finality or temporal-evidence decision.
  if (
    typeof tx.timeFirstSeen !== "number" ||
    !Number.isSafeInteger(tx.timeFirstSeen) ||
    tx.timeFirstSeen < 0
  ) {
    return {
      ok: false,
      httpStatus: 502,
      code: "MALFORMED_CHRONIK_TX",
      message: "Chronik returned malformed timeFirstSeen field",
    };
  }

  const isAvalancheFinal = tx.isFinal === true;
  if (!validConfirmedBlock && !isAvalancheFinal) {
    return {
      ok: false,
      httpStatus: 402,
      code: "TRANSACTION_NOT_FINAL",
      message: "Transaction is neither confirmed nor Avalanche-final",
    };
  }

  // 8c. Select temporal evidence in strict order:
  // 1. PRIMARY: If tx.timeFirstSeen > 0, use timeFirstSeen regardless of whether
  //    the tx is currently confirmed or still in mempool.
  // 2. FALLBACK: If tx.timeFirstSeen === 0 AND tx.block is a structurally valid
  //    confirmed block, use tx.block.timestamp.
  // 3. NO TRUSTWORTHY TIME: If tx.timeFirstSeen === 0 AND there is no valid
  //    confirmed block, fail closed with TRANSACTION_TIME_UNKNOWN (HTTP 502).
  const timeFirstSeen = tx.timeFirstSeen;
  let observedAt: number;

  if (timeFirstSeen > 0) {
    observedAt = timeFirstSeen;
  } else if (validConfirmedBlock && tx.block !== undefined) {
    observedAt = tx.block.timestamp;
  } else {
    return {
      ok: false,
      httpStatus: 502,
      code: "TRANSACTION_TIME_UNKNOWN",
      message:
        "Transaction temporal evidence cannot be proven: timeFirstSeen is 0 and no confirmed block is available",
    };
  }

  // 8d. Server-authoritative temporal fencing against invoice.issuedAt
  if (observedAt < invoice.issuedAt - TEMPORAL_FENCE_TOLERANCE_SECONDS) {
    return {
      ok: false,
      httpStatus: 402,
      code: "HISTORICAL_TRANSACTION",
      message: `Transaction temporal evidence (${observedAt}) is older than invoice issuance (${invoice.issuedAt}) beyond tolerance (${TEMPORAL_FENCE_TOLERANCE_SECONDS}s)`,
    };
  }

  // 9. Derive expected locking script from invoice.payTo
  // ALWAYS validate invoice.payTo with the canonical strict CashAddr decoder
  // BEFORE invoking any custom addressToScript hook.
  try {
    decodeCashAddress(invoice.payTo);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 500,
      code: "PAY_TO_MISMATCH",
      message: `Invalid canonical CashAddr invoice payTo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let expectedScriptHex: string;
  try {
    expectedScriptHex = options.addressToScript
      ? options.addressToScript(invoice.payTo)
      : cashAddressToOutputScriptHex(invoice.payTo);
  } catch (err) {
    return {
      ok: false,
      httpStatus: 500,
      code: "PAY_TO_MISMATCH",
      message: `Failed to derive locking script for invoice payTo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  expectedScriptHex = expectedScriptHex.toLowerCase();

  // 9. Inspect actual transaction outputs server-side to find the payment output
  let matchedOutputIndex = -1;
  let hasScriptMatch = false;
  let hasTokenOutput = false;
  let wrongAmountSeen: bigint | undefined;

  for (let idx = 0; idx < tx.outputs.length; idx++) {
    const output = tx.outputs[idx]!;
    if (output.outputScript.toLowerCase() === expectedScriptHex) {
      hasScriptMatch = true;

      // Token outputs cannot satisfy XEC payment requirements
      if (output.token !== undefined) {
        hasTokenOutput = true;
        continue;
      }

      // Check exact amount semantics
      if (output.sats === invoice.amountSats) {
        matchedOutputIndex = idx;
        break;
      } else {
        wrongAmountSeen = output.sats;
      }
    }
  }

  if (!hasScriptMatch) {
    return {
      ok: false,
      httpStatus: 402,
      code: "PAY_TO_MISMATCH",
      message: "Transaction contains no output paying the required destination",
    };
  }

  if (matchedOutputIndex === -1) {
    if (hasTokenOutput) {
      return {
        ok: false,
        httpStatus: 402,
        code: "TOKEN_OUTPUT_DISALLOWED",
        message: "Matching output contains tokens and cannot be used for XEC settlement",
      };
    }
    if (wrongAmountSeen !== undefined) {
      return {
        ok: false,
        httpStatus: 402,
        code: "AMOUNT_MISMATCH",
        message: `Output amount (${wrongAmountSeen} sats) does not match exact invoice requirement (${invoice.amountSats} sats)`,
      };
    }
    return {
      ok: false,
      httpStatus: 402,
      code: "OUTPUT_NOT_FOUND",
      message: "No valid payment output found satisfying invoice requirements",
    };
  }

  // 10. Atomic commit in authoritative store
  const commitResult = await options.store.commitPaid(
    proof.invoiceHash,
    proof.txid,
    now,
  );

  if (!commitResult.ok) {
    if (commitResult.code === "CONFLICT") {
      return {
        ok: false,
        httpStatus: 409,
        code: "TXID_CONFLICT",
        message: commitResult.message,
      };
    }
    if (commitResult.code === "TXID_REUSED") {
      return {
        ok: false,
        httpStatus: 409,
        code: "TXID_REUSED",
        message: commitResult.message,
      };
    }
    return {
      ok: false,
      httpStatus: 400,
      code: "INVOICE_NOT_FOUND",
      message: commitResult.message,
    };
  }

  return {
    ok: true,
    status: "UNLOCKED",
    invoice: commitResult.record,
    proof,
    matchedOutputIndex,
    transaction: tx,
    idempotent: commitResult.idempotent,
  };
}
