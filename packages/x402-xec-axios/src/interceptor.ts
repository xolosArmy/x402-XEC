import {
  authorizationSchema,
  authorizationSigningMessage,
  canonicalHash,
  computeInvoiceHash,
  computeResourceHash,
  invoiceSchema,
  parseAmountSats,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
  type Authorization,
  type CanonicalValue,
  type Invoice,
  type ResourceRequest,
  type SignatureProvider,
  type UnsignedAuthorization,
} from "@x402-xec/core";
import type { OfflinePaymentPreparer } from "@x402-xec/payments";
import {
  isAxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

const PAYMENT_HEADER = "PAYMENT-SIGNATURE";
const PAYMENT_SCHEME = "xec-prepaid-utxo";
const PAYMENT_ASSET = "XEC";
const RETRY_MARKER = "__x402XecPaymentAttempted";

export interface XecSigner extends SignatureProvider {
  readonly payer: string;
  readonly transaction: {
    readonly txid: string;
    readonly vout: number;
  };
}

interface X402XecPaymentInterceptorBaseOptions {
  readonly maxPaymentSats: bigint | number | string;
  /** Test hook. Returns epoch seconds. */
  readonly now?: () => number;
}

export type X402XecPaymentInterceptorOptions =
  X402XecPaymentInterceptorBaseOptions & (
    | {
      /** Legacy local-only mock signer mode. */
      readonly signer: XecSigner;
      readonly paymentPreparer?: never;
    }
    | {
      /** Preferred local simulation using offline transaction construction. */
      readonly paymentPreparer: Pick<OfflinePaymentPreparer, "prepare">;
      readonly signer?: never;
    }
  );

export interface TestOnlyMockXecSignerOptions {
  readonly payer: string;
  readonly transaction?: {
    readonly txid: string;
    readonly vout: number;
  };
}

interface PaymentOffer {
  readonly invoice: Invoice;
  readonly resource: ResourceRequest;
}

interface RetryConfig extends InternalAxiosRequestConfig {
  [RETRY_MARKER]?: boolean;
}

/**
 * Installs a local-only response interceptor and returns the same Axios instance.
 */
export function withX402XecPaymentInterceptor(
  client: AxiosInstance,
  options: X402XecPaymentInterceptorOptions,
): AxiosInstance {
  const maxPaymentSats = readMaximum(options.maxPaymentSats);
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  validatePaymentMode(options);

  client.interceptors.response.use(undefined, async (error: unknown) => {
    if (!isAxiosError(error) || error.response?.status !== 402 || !error.config) {
      throw error;
    }

    const config = error.config as RetryConfig;
    if (config[RETRY_MARKER] === true || hasPaymentHeader(config)) {
      throw error;
    }

    const offer = parseAndValidateOffer(error.response.data, config, now());
    if (parseAmountSats(offer.invoice.amountSats) > maxPaymentSats) {
      throw new Error(
        `x402-XEC payment amount ${offer.invoice.amountSats} exceeds maxPaymentSats ${maxPaymentSats}`,
      );
    }

    const paymentEnvelope = options.paymentPreparer === undefined
      ? encodeBase64UrlJson({
        invoice: offer.invoice,
        authorization: await createAuthorization(offer.invoice, options.signer),
      })
      : (await options.paymentPreparer.prepare(offer)).paymentSignature;

    config[RETRY_MARKER] = true;
    config.headers.set(PAYMENT_HEADER, paymentEnvelope);
    return client.request(config);
  });

  return client;
}

function validatePaymentMode(options: X402XecPaymentInterceptorOptions): void {
  const hasSigner = options.signer !== undefined;
  const hasPaymentPreparer = options.paymentPreparer !== undefined;
  if (hasSigner === hasPaymentPreparer) {
    throw new TypeError("configure exactly one of signer or paymentPreparer");
  }
}

/**
 * Deterministic local test signer compatible with MockSignatureVerifier.
 * It does not contain a private key and is not a wallet signature.
 */
export function createTestOnlyMockXecSigner(
  options: TestOnlyMockXecSignerOptions,
): XecSigner {
  const transaction = options.transaction ?? {
    txid: "0".repeat(64),
    vout: 0,
  };
  const signerShape = authorizationSchema.pick({
    payer: true,
    transaction: true,
  }).parse({
    payer: options.payer,
    transaction,
  });

  return {
    payer: signerShape.payer,
    transaction: signerShape.transaction,
    sign(message: string): string {
      return canonicalHash({
        domain: "x402-xec-local-mock-signature-v1",
        message,
        payer: signerShape.payer,
      });
    },
  };
}

async function createAuthorization(
  invoice: Invoice,
  signer: XecSigner,
): Promise<Authorization> {
  const unsigned: UnsignedAuthorization = {
    x402Version: X402_VERSION,
    scheme: XEC_SCHEME,
    network: XEC_MAINNET,
    invoiceHash: computeInvoiceHash(invoice),
    resourceHash: invoice.resourceHash,
    amountSats: invoice.amountSats,
    payTo: invoice.payTo,
    nonce: invoice.nonce,
    payer: signer.payer,
    transaction: signer.transaction,
  };
  const placeholder: Authorization = { ...unsigned, signature: "placeholder" };
  const signature = await signer.sign(authorizationSigningMessage(placeholder));
  return authorizationSchema.parse({ ...unsigned, signature });
}

function parseAndValidateOffer(
  input: unknown,
  config: InternalAxiosRequestConfig,
  now: number,
): PaymentOffer {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("now must return non-negative epoch seconds");
  }
  if (!isRecord(input)) throw new Error("invalid x402-XEC payment response");
  if (input.x402Version !== X402_VERSION) {
    throw new Error("unsupported x402-XEC version");
  }

  const parsedInvoice = invoiceSchema.safeParse(input.invoice);
  if (!parsedInvoice.success) {
    throw new Error(`invalid x402-XEC invoice: ${parsedInvoice.error.issues[0]?.message ?? "malformed"}`);
  }
  const invoice = parsedInvoice.data;

  if (invoice.network !== XEC_MAINNET) throw new Error(`unsupported x402-XEC network: ${invoice.network}`);
  if (invoice.scheme !== XEC_SCHEME) throw new Error(`unsupported x402-XEC invoice scheme: ${invoice.scheme}`);
  if (now < invoice.issuedAt) throw new Error("x402-XEC invoice is not yet valid");
  if (now >= invoice.expiresAt) throw new Error("x402-XEC invoice has expired");
  if (input.invoiceId !== computeInvoiceHash(invoice)) {
    throw new Error("invalid x402-XEC invoice id");
  }

  const resource = parseResource(input.resource);
  if (computeResourceHash(resource) !== invoice.resourceHash) {
    throw new Error("x402-XEC invoice does not match resource metadata");
  }
  validateRequestedResource(resource, config);

  if (!Array.isArray(input.accepts)) throw new Error("invalid x402-XEC payment methods");
  const accepted = input.accepts.find((candidate) => (
    isRecord(candidate)
    && candidate.asset === PAYMENT_ASSET
    && candidate.network === XEC_MAINNET
    && candidate.scheme === PAYMENT_SCHEME
    && candidate.amountSats === invoice.amountSats
    && candidate.payTo === invoice.payTo
    && candidate.paymentHeader === PAYMENT_HEADER
  ));
  if (accepted === undefined) {
    throw new Error("unsupported or inconsistent x402-XEC payment method");
  }

  return { invoice, resource };
}

function parseResource(input: unknown): ResourceRequest {
  if (!isRecord(input)) throw new Error("invalid x402-XEC resource metadata");
  const { serverOrigin, method, path, query, body } = input;
  if (
    typeof serverOrigin !== "string"
    || typeof method !== "string"
    || typeof path !== "string"
    || (query !== undefined && !isQuery(query))
  ) {
    throw new Error("invalid x402-XEC resource metadata");
  }
  return {
    serverOrigin,
    method,
    path,
    ...(query === undefined ? {} : { query }),
    ...(body === undefined ? {} : { body: body as CanonicalValue }),
  };
}

function validateRequestedResource(
  resource: ResourceRequest,
  config: InternalAxiosRequestConfig,
): void {
  let requested: URL;
  try {
    requested = new URL(config.url ?? "", config.baseURL);
  } catch {
    throw new Error("cannot bind x402-XEC invoice to request URL");
  }
  const method = (config.method ?? "get").toUpperCase();
  if (
    requested.origin !== resource.serverOrigin
    || requested.pathname !== resource.path
    || method !== resource.method.toUpperCase()
  ) {
    throw new Error("x402-XEC resource metadata does not match the original request");
  }
}

function hasPaymentHeader(config: InternalAxiosRequestConfig): boolean {
  return config.headers.has(PAYMENT_HEADER);
}

function readMaximum(input: bigint | number | string): bigint {
  let maximum: bigint;
  try {
    if (typeof input === "bigint") maximum = input;
    else if (typeof input === "number" && Number.isSafeInteger(input)) maximum = BigInt(input);
    else if (typeof input === "string" && /^(0|[1-9][0-9]*)$/.test(input)) maximum = BigInt(input);
    else throw new TypeError();
  } catch {
    throw new TypeError("maxPaymentSats must be a non-negative integer");
  }
  if (maximum < 0n) throw new RangeError("maxPaymentSats must be non-negative");
  return maximum;
}

function encodeBase64UrlJson(input: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function isQuery(input: unknown): input is readonly (readonly [string, string])[] {
  return Array.isArray(input) && input.every((pair) => (
    Array.isArray(pair)
    && pair.length === 2
    && typeof pair[0] === "string"
    && typeof pair[1] === "string"
  ));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
