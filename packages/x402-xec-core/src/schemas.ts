import { z } from "zod";

export const X402_VERSION = 1 as const;
export const XEC_MAINNET = "xec:mainnet" as const;
export const XEC_SCHEME = "exact" as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
const amount = z.string().regex(/^[1-9][0-9]*$/, "amountSats must be a canonical positive integer string");
const address = z.string().regex(/^ecash:[qp][a-z0-9]{41,}$/, "expected a lowercase prefixed eCash address");
const nonce = z.string().min(22).max(128).regex(/^[A-Za-z0-9_-]+$/, "nonce must be unpadded base64url");
const timestamp = z.number().int().nonnegative().safe();

export const invoiceSchema = z.object({
  x402Version: z.literal(X402_VERSION), scheme: z.literal(XEC_SCHEME), network: z.literal(XEC_MAINNET),
  resourceHash: hash, amountSats: amount, payTo: address, nonce, issuedAt: timestamp, expiresAt: timestamp,
}).strict().refine((value) => value.expiresAt > value.issuedAt, { message: "expiresAt must exceed issuedAt", path: ["expiresAt"] });

export const unsignedAuthorizationSchema = z.object({
  x402Version: z.literal(X402_VERSION), scheme: z.literal(XEC_SCHEME), network: z.literal(XEC_MAINNET),
  invoiceHash: hash, resourceHash: hash, amountSats: amount, payTo: address, nonce, payer: address,
  transaction: z.object({ txid: hash, vout: z.number().int().nonnegative().safe() }).strict(),
}).strict();
export const authorizationSchema = unsignedAuthorizationSchema.extend({
  signature: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/, "signature must be unpadded base64url"),
}).strict();

export type Invoice = z.infer<typeof invoiceSchema>;
export type UnsignedAuthorization = z.infer<typeof unsignedAuthorizationSchema>;
export type Authorization = z.infer<typeof authorizationSchema>;
export const parseAmountSats = (value: string): bigint => BigInt(amount.parse(value));

export const x402SettlementProofV1Schema = z.object({
  x402Version: z.literal(X402_VERSION),
  network: z.literal(XEC_MAINNET),
  invoiceHash: hash,
  txid: hash,
}).strict();

export type X402SettlementProofV1 = z.infer<typeof x402SettlementProofV1Schema>;

export interface SafeWalletSettlementReceiptV1 {
  readonly status: "settled";
  readonly network: "xec:mainnet";
  readonly executionId: string;
  readonly approvalId: string;
  readonly requestId?: string;
  readonly txid: string;
  readonly settledAt: number;
}

export function createSettlementProof(params: {
  readonly invoiceHash: string;
  readonly txid: string;
  readonly network?: typeof XEC_MAINNET;
}): X402SettlementProofV1 {
  return x402SettlementProofV1Schema.parse({
    x402Version: X402_VERSION,
    network: params.network ?? XEC_MAINNET,
    invoiceHash: params.invoiceHash,
    txid: params.txid,
  });
}

export function createSettlementProofFromReceipt(
  receipt: Pick<SafeWalletSettlementReceiptV1, "txid"> & { readonly network?: string },
  invoiceHash: string,
): X402SettlementProofV1 {
  return createSettlementProof({
    invoiceHash,
    txid: receipt.txid,
    network: (receipt.network as typeof XEC_MAINNET) ?? XEC_MAINNET,
  });
}
