import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createInvoice,
  type ResourceRequest,
  type SignatureProvider,
} from "@x402-xec/core";
import {
  ChronikTxBroadcaster,
  ChronikUtxoProvider,
  LivePaymentOrchestrator,
  type ApprovalDecision,
  type ApprovalProvider,
  type BroadcastProvider,
  type LivePaymentResult,
  type PaymentPlan,
  type UtxoProvider,
} from "@x402-xec/payments";
import {
  Address,
  ALL_BIP143,
  Ecc,
  P2PKHSignatory,
  shaRmd160,
  signMsg,
} from "ecash-lib";

export type CliMode = "dry-run" | "broadcast";

export interface ParsedCliOptions {
  readonly mode: CliMode;
  readonly allowBroadcast: boolean;
  readonly confirmation: boolean;
  readonly chronikUrl?: string;
  readonly fromAddress?: string;
  readonly wif?: string;
  readonly privateKey?: string;
  readonly maxPaymentSats?: string;
  readonly payTo?: string;
  readonly amountSats?: string;
}

export interface ManualPaymentCliDependencies {
  readonly utxoProvider?: UtxoProvider;
  readonly broadcastProvider?: BroadcastProvider;
  readonly approvalProvider?: ApprovalProvider;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const RESOURCE: ResourceRequest = {
  serverOrigin: "https://manual-payment.invalid",
  method: "POST",
  path: "/controlled-payment-experiment",
  query: [],
  body: null,
};

const BOOLEAN_FLAGS = new Map<string, keyof ParsedCliOptions>([
  ["--allow-broadcast", "allowBroadcast"],
  ["--yes-i-understand-this-broadcasts-xec", "confirmation"],
]);

const VALUE_FLAGS = new Map<string, keyof ParsedCliOptions>([
  ["--chronik-url", "chronikUrl"],
  ["--from-address", "fromAddress"],
  ["--wif", "wif"],
  ["--private-key", "privateKey"],
  ["--max-payment-sats", "maxPaymentSats"],
  ["--pay-to", "payTo"],
  ["--amount-sats", "amountSats"],
]);

export function parseCliArgs(argv: readonly string[]): ParsedCliOptions {
  let mode: CliMode = "dry-run";
  let index = 0;
  if (argv[0] === "dry-run" || argv[0] === "broadcast") {
    mode = argv[0];
    index = 1;
  }

  const values: Record<string, string | boolean> = {};
  for (; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const booleanField = BOOLEAN_FLAGS.get(flag);
    if (booleanField !== undefined) {
      rejectDuplicate(values, booleanField);
      values[booleanField] = true;
      continue;
    }

    const valueField = VALUE_FLAGS.get(flag);
    if (valueField === undefined) {
      throw new CliUsageError(`unknown argument: ${flag}`);
    }
    rejectDuplicate(values, valueField);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${flag} requires a value`);
    }
    values[valueField] = value;
    index += 1;
  }

  const parsed: ParsedCliOptions = {
    mode,
    allowBroadcast: values.allowBroadcast === true,
    confirmation: values.confirmation === true,
    ...(typeof values.chronikUrl === "string" ? { chronikUrl: values.chronikUrl } : {}),
    ...(typeof values.fromAddress === "string" ? { fromAddress: values.fromAddress } : {}),
    ...(typeof values.wif === "string" ? { wif: values.wif } : {}),
    ...(typeof values.privateKey === "string" ? { privateKey: values.privateKey } : {}),
    ...(typeof values.maxPaymentSats === "string" ? { maxPaymentSats: values.maxPaymentSats } : {}),
    ...(typeof values.payTo === "string" ? { payTo: values.payTo } : {}),
    ...(typeof values.amountSats === "string" ? { amountSats: values.amountSats } : {}),
  };
  validateModeGates(parsed);
  return parsed;
}

export async function runManualPaymentCli(
  argv: readonly string[],
  dependencies: ManualPaymentCliDependencies = {},
): Promise<LivePaymentResult> {
  const options = parseCliArgs(argv);
  const required = requiredExecutionOptions(options, dependencies);
  const secretKey = readSecretKey(options);

  try {
    const ecc = new Ecc();
    if (!ecc.isValidSeckey(secretKey)) {
      throw new CliUsageError("private key is not a valid secp256k1 key");
    }
    const publicKey = ecc.derivePubkey(secretKey);
    const derivedAddress = Address.p2pkh(shaRmd160(publicKey)).toString();
    if (derivedAddress !== required.fromAddress) {
      throw new CliUsageError("--from-address does not match the supplied signing key");
    }

    const now = checkedNow(dependencies.now?.() ?? Math.floor(Date.now() / 1_000));
    const invoice = createInvoice({
      request: RESOURCE,
      amountSats: BigInt(required.amountSats),
      payTo: required.payTo,
      nonce: randomBytes(24).toString("base64url"),
      issuedAt: now,
      expiresAt: now + 300,
    });
    const dryRun = options.mode === "dry-run";
    const utxoProvider = dependencies.utxoProvider ?? new ChronikUtxoProvider({
      endpoint: required.chronikUrl,
      address: required.fromAddress,
    });
    const broadcastProvider = dependencies.broadcastProvider ?? (dryRun
      ? undefined
      : new ChronikTxBroadcaster({ endpoint: required.chronikUrl }));
    const approvalProvider = dependencies.approvalProvider
      ?? new ExplicitConfirmationApprovalProvider(options.confirmation);
    const signatureProvider: SignatureProvider = {
      sign(message) {
        return signMsg(message, secretKey)
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "");
      },
    };
    const orchestrator = new LivePaymentOrchestrator({
      utxoProvider,
      signatureProvider,
      payer: required.fromAddress,
      changeAddress: required.fromAddress,
      signatoryForUtxo: () => P2PKHSignatory(secretKey, publicKey, ALL_BIP143),
      dryRun,
      allowBroadcast: options.allowBroadcast,
      paymentPolicy: {
        maxPaymentSats: required.maxPaymentSats,
        allowedNetworks: ["xec:mainnet"],
        allowedSchemes: ["exact"],
        allowedPayToAddresses: [required.payTo],
        requireManualApproval: true,
      },
      ...(broadcastProvider === undefined ? {} : { broadcastProvider }),
      approvalProvider,
      now: () => now,
    });
    const result = await orchestrator.execute({ invoice, resource: RESOURCE });
    printResult(result, dependencies.log ?? console.log);
    return result;
  } finally {
    secretKey.fill(0);
  }
}

export class CliUsageError extends Error {
  readonly code = "CLI_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class ExplicitConfirmationApprovalProvider implements ApprovalProvider {
  readonly #confirmed: boolean;

  constructor(confirmed: boolean) {
    this.#confirmed = confirmed;
  }

  async approvePayment(_plan: PaymentPlan): Promise<ApprovalDecision> {
    return this.#confirmed
      ? { approved: true, approver: "explicit-cli-confirmation" }
      : { approved: false, reason: "explicit broadcast confirmation is missing" };
  }
}

interface RequiredExecutionOptions {
  readonly chronikUrl: string;
  readonly fromAddress: string;
  readonly payTo: string;
  readonly amountSats: string;
  readonly maxPaymentSats: string;
}

function requiredExecutionOptions(
  options: ParsedCliOptions,
  dependencies: ManualPaymentCliDependencies,
): RequiredExecutionOptions {
  const fromAddress = requireValue(options.fromAddress, "--from-address");
  const payTo = requireValue(options.payTo, "--pay-to");
  const amountSats = canonicalPositiveSats(
    requireValue(options.amountSats, "--amount-sats"),
    "--amount-sats",
  );
  const maxPaymentSats = options.maxPaymentSats === undefined
    ? amountSats
    : canonicalPositiveSats(options.maxPaymentSats, "--max-payment-sats");
  const chronikUrl = options.chronikUrl ?? (dependencies.utxoProvider === undefined
    ? requireValue(undefined, "--chronik-url")
    : "https://injected-provider.invalid");
  validateAddress(fromAddress, "--from-address");
  validateAddress(payTo, "--pay-to");
  return { chronikUrl, fromAddress, payTo, amountSats, maxPaymentSats };
}

function validateModeGates(options: ParsedCliOptions): void {
  if (options.wif !== undefined && options.privateKey !== undefined) {
    throw new CliUsageError("use exactly one of --wif or --private-key");
  }
  if (options.mode !== "broadcast") return;

  if (!options.allowBroadcast) {
    throw new CliUsageError("broadcast mode requires --allow-broadcast");
  }
  if (!options.confirmation) {
    throw new CliUsageError(
      "broadcast mode requires --yes-i-understand-this-broadcasts-xec",
    );
  }
  if (options.maxPaymentSats === undefined) {
    throw new CliUsageError("broadcast mode requires --max-payment-sats");
  }
  for (const [value, flag] of [
    [options.chronikUrl, "--chronik-url"],
    [options.fromAddress, "--from-address"],
    [options.payTo, "--pay-to"],
    [options.amountSats, "--amount-sats"],
  ] as const) {
    requireValue(value, flag);
  }
  if (options.wif === undefined && options.privateKey === undefined) {
    throw new CliUsageError(
      "broadcast mode requires exactly one of --wif or --private-key",
    );
  }
}

function readSecretKey(options: ParsedCliOptions): Uint8Array {
  if (options.wif === undefined && options.privateKey === undefined) {
    throw new CliUsageError("payment preparation requires --wif or --private-key");
  }
  if (options.privateKey !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(options.privateKey)) {
      throw new CliUsageError("--private-key must be exactly 32 bytes of hex");
    }
    return Uint8Array.from(Buffer.from(options.privateKey, "hex"));
  }
  return decodeCompressedMainnetWif(options.wif!);
}

function decodeCompressedMainnetWif(wif: string): Uint8Array {
  const decoded = decodeBase58(wif);
  if (decoded.length !== 38) {
    throw new CliUsageError("--wif must be a compressed mainnet WIF");
  }
  const payload = decoded.subarray(0, 34);
  const checksum = decoded.subarray(34);
  const expected = sha256d(payload).subarray(0, 4);
  if (!timingSafeEqual(checksum, expected)) {
    throw new CliUsageError("--wif checksum is invalid");
  }
  if (payload[0] !== 0x80 || payload[33] !== 0x01) {
    throw new CliUsageError("--wif must be a compressed mainnet WIF");
  }
  return Uint8Array.from(payload.subarray(1, 33));
}

function decodeBase58(value: string): Uint8Array {
  if (!/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(value)) {
    throw new CliUsageError("--wif is not valid Base58");
  }
  let number = 0n;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const character of value) {
    number = number * 58n + BigInt(alphabet.indexOf(character));
  }
  let hex = number.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const body = number === 0n
    ? new Uint8Array()
    : Uint8Array.from(Buffer.from(hex, "hex"));
  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0;
  const decoded = new Uint8Array(leadingZeroes + body.length);
  decoded.set(body, leadingZeroes);
  return decoded;
}

function sha256d(value: Uint8Array): Buffer {
  const first = createHash("sha256").update(value).digest();
  return createHash("sha256").update(first).digest();
}

function printResult(result: LivePaymentResult, log: (line: string) => void): void {
  log(JSON.stringify({
    mode: result.dryRun ? "dry-run" : "broadcast",
    broadcasted: result.broadcasted,
    paymentPlan: {
      amountSats: result.plannedBroadcast.amountSats,
      payTo: result.plannedBroadcast.payTo,
      transactionTxid: result.plannedBroadcast.transactionTxid,
      fundingOutpoint: result.fundingOutpoint,
      feeSats: result.fundingTransaction.feeSats,
      changeSats: result.fundingTransaction.changeSats,
    },
    paymentSignatureHeader: result.paymentSignature,
    ...(result.broadcasted
      ? { txid: result.broadcastResult.txid }
      : { warning: "DRY RUN ONLY: transaction was not broadcast" }),
  }, null, 2));
}

function rejectDuplicate(
  values: Record<string, string | boolean>,
  field: keyof ParsedCliOptions,
): void {
  if (values[field] !== undefined) {
    throw new CliUsageError(`duplicate argument for ${field}`);
  }
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`payment execution requires ${flag}`);
  }
  return value;
}

function canonicalPositiveSats(value: string, flag: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliUsageError(`${flag} must be a canonical positive integer`);
  }
  return value;
}

function validateAddress(value: string, flag: string): void {
  let address: Address;
  try {
    address = Address.fromCashAddress(value);
  } catch {
    throw new CliUsageError(`${flag} must be a valid eCash address`);
  }
  if (address.prefix !== "ecash" || address.type !== "p2pkh") {
    throw new CliUsageError(`${flag} must be an eCash mainnet P2PKH address`);
  }
}

function checkedNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("now must return non-negative epoch seconds");
  }
  return value;
}
