export const XEC_ATOMIC_UNITS_PER_XEC = 100n;
export const PAYMENT_AMOUNT_ATOMIC = "10000";
export const PAYMENT_DISPLAY_AMOUNT = "100 XEC";
export const FIXTURE_PAY_TO =
  "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";

export interface ExperimentalPaymentRequired {
  readonly x402Version: 2;
  readonly error: string;
  readonly resource: {
    readonly url: string;
    readonly description: string;
    readonly mimeType: "application/json";
    readonly serviceName: "x402eCash";
  };
  readonly accepts: readonly [{
    readonly scheme: "xec-prepaid-utxo";
    readonly network: "xec:mainnet";
    readonly amount: string;
    readonly asset: "XEC";
    readonly payTo: string;
    readonly maxTimeoutSeconds: 60;
    readonly extra: {
      readonly displayAmount: string;
      readonly experimental: true;
      readonly gate: "H2A";
    };
  }];
  readonly extensions: Readonly<Record<string, never>>;
}

export function assertDisplayAmountMatchesAtomic(
  displayAmount: string,
  atomicAmount: string,
): void {
  const displayMatch = /^([1-9][0-9]*) XEC$/.exec(displayAmount);
  const displayXecValue = displayMatch?.[1];
  if (!displayXecValue || !/^[1-9][0-9]*$/.test(atomicAmount)) {
    throw new Error("Gate H2A price must use canonical XEC display and atomic amounts");
  }

  const displayXec = BigInt(displayXecValue);
  if (displayXec * XEC_ATOMIC_UNITS_PER_XEC !== BigInt(atomicAmount)) {
    throw new Error("Gate H2A display amount does not match its atomic amount");
  }
}

assertDisplayAmountMatchesAtomic(PAYMENT_DISPLAY_AMOUNT, PAYMENT_AMOUNT_ATOMIC);

export function createPaymentRequired(
  canonicalResourceUrl: string,
): ExperimentalPaymentRequired {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: canonicalResourceUrl,
      description: "x402eCash WebMCP Challenge demo resource",
      mimeType: "application/json",
      serviceName: "x402eCash",
    },
    accepts: [{
      scheme: "xec-prepaid-utxo",
      network: "xec:mainnet",
      amount: PAYMENT_AMOUNT_ATOMIC,
      asset: "XEC",
      payTo: FIXTURE_PAY_TO,
      maxTimeoutSeconds: 60,
      extra: {
        displayAmount: PAYMENT_DISPLAY_AMOUNT,
        experimental: true,
        gate: "H2A",
      },
    }],
    extensions: {},
  };
}

export function encodePaymentRequired(
  paymentRequired: ExperimentalPaymentRequired,
): string {
  return Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
}
