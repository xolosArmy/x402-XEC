import { ChronikClient } from "chronik-client";

export interface BroadcastResult {
  readonly txid: string;
  readonly rawResponse?: unknown;
}

/** Dangerous network boundary that must never be selected implicitly. */
export interface BroadcastProvider {
  broadcastTx(rawTxHex: string): Promise<BroadcastResult>;
}

export class BroadcastDisabledError extends Error {
  readonly code = "BROADCAST_DISABLED";

  constructor(options?: ErrorOptions) {
    super("Transaction broadcast is disabled", options);
    this.name = "BroadcastDisabledError";
  }
}

export class BroadcastRejectedError extends Error {
  readonly code = "BROADCAST_REJECTED";

  constructor(options?: ErrorOptions) {
    super("Transaction broadcast was rejected", options);
    this.name = "BroadcastRejectedError";
  }
}

export class BroadcastNetworkError extends Error {
  readonly code = "BROADCAST_NETWORK_ERROR";

  constructor(options?: ErrorOptions) {
    super("Transaction broadcast failed because of a network error", options);
    this.name = "BroadcastNetworkError";
  }
}

/** Safe provider for code paths without an explicitly configured broadcaster. */
export class DisabledBroadcastProvider implements BroadcastProvider {
  async broadcastTx(_rawTxHex: string): Promise<never> {
    throw new BroadcastDisabledError();
  }
}

/**
 * Deterministic test double. It performs no validation or I/O and must not be
 * used as evidence that a transaction reached the network.
 */
export class TestOnlyMockBroadcastProvider implements BroadcastProvider {
  readonly broadcasts: string[] = [];
  readonly #txid: string;

  constructor(txid: string) {
    this.#txid = txid;
  }

  async broadcastTx(rawTxHex: string): Promise<BroadcastResult> {
    this.broadcasts.push(rawTxHex);
    return { txid: this.#txid };
  }
}

interface ChronikBroadcastResponse {
  readonly txid: string;
}

/** Minimal client boundary used to keep all automated tests offline. */
export interface ChronikBroadcastClient {
  broadcastTx(
    rawTx: string,
    skipTokenChecks?: boolean,
  ): Promise<ChronikBroadcastResponse>;
}

export interface ChronikTxBroadcasterConfig {
  /** Explicit Chronik HTTP(S) endpoint. There is intentionally no default. */
  readonly endpoint: string;
  /** Test seam for mocked Chronik responses; production callers should omit it. */
  readonly client?: ChronikBroadcastClient;
}

/**
 * Opt-in transaction broadcaster for one explicitly configured Chronik endpoint.
 *
 * Construction performs no I/O. `broadcastTx` is the only operation that can
 * contact Chronik, and Chronik token-safety checks remain enabled.
 */
export class ChronikTxBroadcaster implements BroadcastProvider {
  readonly endpoint: string;
  readonly #client: ChronikBroadcastClient;

  constructor(config: ChronikTxBroadcasterConfig) {
    this.endpoint = validateEndpoint(config.endpoint);
    this.#client = config.client ?? new ChronikClient([this.endpoint]);
  }

  async broadcastTx(rawTxHex: string): Promise<BroadcastResult> {
    try {
      const response = await this.#client.broadcastTx(rawTxHex, false);
      if (!isTxid(response.txid)) {
        throw new TypeError(
          "Chronik broadcast response txid must be 64 lowercase hex characters",
        );
      }
      return { txid: response.txid, rawResponse: response };
    } catch (error) {
      if (
        error instanceof BroadcastRejectedError
        || error instanceof BroadcastNetworkError
      ) {
        throw error;
      }
      if (isChronikRejection(error)) {
        throw new BroadcastRejectedError({ cause: error });
      }
      throw new BroadcastNetworkError({ cause: error });
    }
  }
}

function validateEndpoint(endpoint: string): string {
  if (endpoint.length === 0) throw new TypeError("Chronik endpoint is required");
  if (endpoint.endsWith("/")) {
    throw new TypeError("Chronik endpoint must not end with '/'");
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("Chronik endpoint must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Chronik endpoint must be a valid HTTP(S) URL");
  }
  return endpoint;
}

function isTxid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isChronikRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;

  const status = readStatus(error);
  if (status !== undefined && status >= 400 && status < 500) return true;

  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("failed getting /broadcast-tx:")
    || message.includes("broadcast failed")
    || message.includes("transaction rejected")
    || message.includes("mempool reject")
    || message.includes("token burn");
}

function readStatus(error: Record<string, unknown>): number | undefined {
  if (typeof error.status === "number") return error.status;
  const response = error.response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }
  return undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
