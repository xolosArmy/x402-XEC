import type { SignatureProvider } from "@x402-xec/core";
import type { FundingUtxo } from "@x402-xec/transactions";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  Address,
  ALL_BIP143,
  Ecc,
  P2PKHSignatory,
  shaRmd160,
  signMsg,
  type Signatory,
} from "ecash-lib";

/** Tonalli Wallet / RMZWallet BIP44 receive and change paths. */
export const TONALLI_RECEIVE_PATH_PREFIX = "m/44'/899'/0'/0";
export const TONALLI_CHANGE_PATH_PREFIX = "m/44'/899'/0'/1";
export const TONALLI_DERIVATION_PATH = "m/44'/899'/0'/0/0";

/** @deprecated Use TONALLI_DERIVATION_PATH. */
export const TONALLI_ECASH_DERIVATION_PATH = TONALLI_DERIVATION_PATH;

export interface EcashWalletSigner extends SignatureProvider {
  readonly address: string;
  signatoryForUtxo(utxo: FundingUtxo): Signatory;
  destroy(): void;
}

/**
 * In-memory signer derived from a BIP39 mnemonic.
 *
 * The mnemonic and BIP39 seed are discarded during construction. Only the
 * derived key required for this signer's lifetime remains in memory.
 */
export class EcashMnemonicSigner implements EcashWalletSigner {
  readonly address: string;
  readonly #publicKey: Uint8Array;
  readonly #secretKey: Uint8Array;
  #destroyed = false;

  constructor(mnemonic: string) {
    const normalized = normalizeMnemonic(mnemonic);
    if (!validateMnemonic(normalized, wordlist)) {
      throw new TypeError("mnemonic is not a valid BIP39 English seed phrase");
    }

    const seed = mnemonicToSeedSync(normalized);
    let root: HDKey | undefined;
    let child: HDKey | undefined;
    try {
      root = HDKey.fromMasterSeed(seed);
      child = root.derive(TONALLI_DERIVATION_PATH);
      const derivedKey = child.privateKey;
      if (derivedKey === null) {
        throw new Error("mnemonic derivation did not produce a private key");
      }
      this.#secretKey = Uint8Array.from(derivedKey);
    } finally {
      child?.wipePrivateData();
      root?.wipePrivateData();
      seed.fill(0);
    }

    const ecc = new Ecc();
    if (!ecc.isValidSeckey(this.#secretKey)) {
      this.#secretKey.fill(0);
      throw new Error("mnemonic derivation produced an invalid signing key");
    }
    this.#publicKey = ecc.derivePubkey(this.#secretKey);
    this.address = Address.p2pkh(shaRmd160(this.#publicKey)).toString();
  }

  sign(message: string): string {
    this.#assertActive();
    return toBase64Url(signMsg(message, this.#secretKey));
  }

  signatoryForUtxo(_utxo: FundingUtxo): Signatory {
    this.#assertActive();
    return P2PKHSignatory(this.#secretKey, this.#publicKey, ALL_BIP143);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#secretKey.fill(0);
    this.#destroyed = true;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("wallet signer has been destroyed");
  }
}

/** Low-level local-testing signer for legacy WIF/private-key compatibility. */
export class EcashPrivateKeySigner implements EcashWalletSigner {
  readonly address: string;
  readonly #publicKey: Uint8Array;
  readonly #secretKey: Uint8Array;
  #destroyed = false;

  constructor(secretKey: Uint8Array) {
    this.#secretKey = Uint8Array.from(secretKey);
    const ecc = new Ecc();
    if (!ecc.isValidSeckey(this.#secretKey)) {
      this.#secretKey.fill(0);
      throw new TypeError("private key is not a valid secp256k1 key");
    }
    this.#publicKey = ecc.derivePubkey(this.#secretKey);
    this.address = Address.p2pkh(shaRmd160(this.#publicKey)).toString();
  }

  sign(message: string): string {
    this.#assertActive();
    return toBase64Url(signMsg(message, this.#secretKey));
  }

  signatoryForUtxo(_utxo: FundingUtxo): Signatory {
    this.#assertActive();
    return P2PKHSignatory(this.#secretKey, this.#publicKey, ALL_BIP143);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#secretKey.fill(0);
    this.#destroyed = true;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("wallet signer has been destroyed");
  }
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.normalize("NFKD").trim().replace(/\s+/g, " ");
}

function toBase64Url(value: string): string {
  return value
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
