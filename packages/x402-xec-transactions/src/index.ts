import {
  invoiceSchema,
  parseAmountSats,
  type FundingOutpoint,
  type Invoice,
} from "@x402-xec/core";
import {
  Address,
  EccDummy,
  Script,
  Tx,
  TxBuilder,
  type Ecc,
  type Signatory,
} from "ecash-lib";

export const DEFAULT_FEE_PER_KB = 1_000n;
export const DEFAULT_DUST_SATS = 546n;

export interface FundingUtxo {
  readonly txid: string;
  readonly outIdx: number;
  /** Canonical, positive base-10 satoshi amount. */
  readonly sats: string;
  /** Lowercase hex locking script of the output being spent. */
  readonly outputScript: string;
  /** Any defined token metadata marks this UTXO as token-bearing. */
  readonly token?: unknown;
}

export interface FundingOutput {
  readonly outIdx: number;
  readonly amountSats: string;
  readonly outputScript: string;
}

export interface BuildFundingTxRequest {
  readonly invoice: Invoice;
  readonly utxos: readonly FundingUtxo[];
  readonly changeAddress: string;
  /**
   * Returns signing behavior for a selected UTXO. The caller retains all key
   * material; this package neither accepts nor stores private keys.
   */
  readonly signatoryForUtxo: (utxo: FundingUtxo) => Signatory;
  /** Canonical, positive base-10 sats/kB. Defaults to 1000 (1 sat/byte). */
  readonly feePerKb?: string;
  /** Canonical, positive base-10 dust threshold. Defaults to 546 sats. */
  readonly dustSats?: string;
}

export interface BuildFundingTxResult {
  readonly rawTx: string;
  readonly txid: string;
  readonly selectedInputs: readonly FundingUtxo[];
  readonly fundingOutpoint: FundingOutpoint;
  readonly fundingOutput: FundingOutput;
  readonly feeSats: string;
  readonly changeSats: string;
}

export class InsufficientFundsError extends Error {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor() {
    super("Insufficient funds to pay the invoice amount and transaction fee");
    this.name = "InsufficientFundsError";
  }
}

/**
 * Constructs and signs an XEC funding transaction entirely in memory.
 *
 * Inputs are selected in request order. Change below `dustSats` is omitted and
 * becomes additional fee. This function has no network or broadcast capability.
 */
export function buildFundingTx(request: BuildFundingTxRequest): BuildFundingTxResult {
  const invoice = invoiceSchema.parse(request.invoice);
  const invoiceAmount = parseAmountSats(invoice.amountSats);
  const feePerKb = parsePositiveAmount(
    request.feePerKb ?? DEFAULT_FEE_PER_KB.toString(),
    "feePerKb",
  );
  const dustSats = parsePositiveAmount(
    request.dustSats ?? DEFAULT_DUST_SATS.toString(),
    "dustSats",
  );
  const paymentScript = addressScript(invoice.payTo, "invoice.payTo");
  const changeScript = addressScript(request.changeAddress, "changeAddress");
  const utxos = request.utxos.map(validateUtxo);

  let selected: readonly ValidatedUtxo[] | undefined;
  for (let count = 1; count <= utxos.length; count += 1) {
    const candidates = utxos.slice(0, count);
    try {
      buildTx(
        candidates,
        paymentScript,
        invoiceAmount,
        changeScript,
        feePerKb,
        dustSats,
        request.signatoryForUtxo,
        new EccDummy(),
      );
      selected = candidates;
      break;
    } catch (error) {
      if (!isInsufficientInputError(error)) throw error;
    }
  }

  if (selected === undefined) throw new InsufficientFundsError();

  const tx = buildTx(
    selected,
    paymentScript,
    invoiceAmount,
    changeScript,
    feePerKb,
    dustSats,
    request.signatoryForUtxo,
  );
  const txid = tx.txid();
  const fundingOutput = tx.outputs[0];
  if (fundingOutput === undefined) {
    throw new Error("Funding transaction has no payment output");
  }

  const inputSats = selected.reduce((sum, utxo) => sum + utxo.sats, 0n);
  const outputSats = tx.outputs.reduce((sum, output) => sum + output.sats, 0n);
  const changeSats = tx.outputs[1]?.sats ?? 0n;

  return {
    rawTx: tx.toHex(),
    txid,
    selectedInputs: selected.map(({ source }) => source),
    fundingOutpoint: { txid, outIdx: 0 },
    fundingOutput: {
      outIdx: 0,
      amountSats: fundingOutput.sats.toString(10),
      outputScript: fundingOutput.script.toHex(),
    },
    feeSats: (inputSats - outputSats).toString(10),
    changeSats: changeSats.toString(10),
  };
}

interface ValidatedUtxo {
  readonly source: FundingUtxo;
  readonly sats: bigint;
  readonly outputScript: Script;
}

function validateUtxo(utxo: FundingUtxo): ValidatedUtxo {
  if (!/^[0-9a-f]{64}$/.test(utxo.txid)) {
    throw new TypeError("Funding UTXO txid must be 64 lowercase hex characters");
  }
  if (!Number.isSafeInteger(utxo.outIdx) || utxo.outIdx < 0) {
    throw new TypeError("Funding UTXO outIdx must be a non-negative safe integer");
  }
  if (utxo.token !== undefined) {
    throw new TypeError("Token-bearing UTXOs cannot fund XEC transactions");
  }
  if (!/^(?:[0-9a-f]{2})+$/.test(utxo.outputScript)) {
    throw new TypeError("Funding UTXO outputScript must be non-empty lowercase hex");
  }
  return {
    source: utxo,
    sats: parsePositiveAmount(utxo.sats, "Funding UTXO sats"),
    outputScript: new Script(Uint8Array.from(Buffer.from(utxo.outputScript, "hex"))),
  };
}

function addressScript(value: string, field: string): Script {
  let address: Address;
  try {
    address = Address.fromCashAddress(value);
  } catch {
    throw new TypeError(`${field} must be a valid eCash cash address`);
  }
  if (address.prefix !== "ecash") {
    throw new TypeError(`${field} must use the ecash mainnet prefix`);
  }
  return address.toScript();
}

function parsePositiveAmount(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${field} must be a canonical positive integer string`);
  }
  return BigInt(value);
}

function buildTx(
  utxos: readonly ValidatedUtxo[],
  paymentScript: Script,
  invoiceAmount: bigint,
  changeScript: Script,
  feePerKb: bigint,
  dustSats: bigint,
  signatoryForUtxo: (utxo: FundingUtxo) => Signatory,
  ecc?: Ecc,
): Tx {
  const builder = new TxBuilder({
    inputs: utxos.map((utxo) => ({
      input: {
        prevOut: { txid: utxo.source.txid, outIdx: utxo.source.outIdx },
        signData: { sats: utxo.sats, outputScript: utxo.outputScript },
      },
      signatory: signatoryForUtxo(utxo.source),
    })),
    outputs: [
      { sats: invoiceAmount, script: paymentScript },
      changeScript,
    ],
  });
  return builder.sign({ ...(ecc === undefined ? {} : { ecc }), feePerKb, dustSats });
}

function isInsufficientInputError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Insufficient input sats");
}
