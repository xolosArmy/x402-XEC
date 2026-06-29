import {
  TxNotFoundError,
  type ChronikTransaction,
  type ChronikTxProvider,
} from "@x402-xec/core";
import {
  ChronikClient,
  type BlockMetadata,
  type Token,
  type Tx,
  type TxOutput,
} from "chronik-client";

type ChronikClientToken = Pick<Token, "atoms" | "isMintBaton" | "tokenId">;
type ChronikClientOutput =
  & Pick<TxOutput, "outputScript" | "sats">
  & { readonly token?: ChronikClientToken };
type ChronikClientTx =
  & Pick<Tx, "isFinal" | "txid">
  & {
    readonly block?: Pick<BlockMetadata, "hash" | "height" | "timestamp">;
    readonly outputs: readonly ChronikClientOutput[];
  };

/** Read-only client subset used by `RealChronikTxProvider`. */
export interface ChronikTxReader {
  tx(txid: string): Promise<ChronikClientTx>;
}

export interface RealChronikTxProviderConfig {
  /** Explicit Chronik HTTP(S) endpoint. There is intentionally no default. */
  readonly endpoint: string;
  /** Test seam for mocked Chronik responses; production callers should omit it. */
  readonly client?: ChronikTxReader;
}

/**
 * Read-only adapter for an explicitly configured Chronik endpoint.
 *
 * Constructing the provider does not connect to Chronik. Network I/O occurs
 * only when `getTx` is called, and this class exposes no broadcast methods.
 */
export class RealChronikTxProvider implements ChronikTxProvider {
  readonly endpoint: string;
  readonly #client: ChronikTxReader;

  constructor(config: RealChronikTxProviderConfig) {
    this.endpoint = validateEndpoint(config.endpoint);
    this.#client = config.client ?? new ChronikClient([this.endpoint]);
  }

  async getTx(txid: string): Promise<ChronikTransaction> {
    let transaction: ChronikClientTx;
    try {
      transaction = await this.#client.tx(txid);
    } catch (error) {
      if (isTxNotFoundError(error, txid)) throw new TxNotFoundError(txid);
      throw error;
    }

    return {
      txid: transaction.txid,
      outputs: transaction.outputs.map((output) => ({
        sats: output.sats,
        outputScript: output.outputScript,
        ...(output.token === undefined ? {} : {
          token: {
            tokenId: output.token.tokenId,
            atoms: output.token.atoms,
            isMintBaton: output.token.isMintBaton,
          },
        }),
      })),
      ...(transaction.block === undefined ? {} : {
        block: {
          height: transaction.block.height,
          hash: transaction.block.hash,
          timestamp: transaction.block.timestamp,
        },
      }),
      isFinal: transaction.isFinal,
    };
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

function isTxNotFoundError(error: unknown, txid: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith(`Failed getting /tx/${txid}: 404:`)
    && error.message.toLowerCase().includes("not found");
}
