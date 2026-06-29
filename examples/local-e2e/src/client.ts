import type { PaymentPreparationResult } from "@x402-xec/payments";
import { OfflinePaymentPreparer, StaticUtxoProvider } from "@x402-xec/payments";
import { ALL_BIP143, P2PKHSignatory } from "ecash-lib";
import {
  createTestOnlyMockXecSigner,
  withX402XecPaymentInterceptor,
  type XecSigner,
} from "@x402-xec/axios";
import axios, { type AxiosInstance } from "axios";
import {
  DEMO_NOW,
  DEMO_PAYER,
  DEMO_PUBLIC_KEY,
  DEMO_SECRET_KEY,
  DEMO_SOURCE_SCRIPT,
  DEMO_TXID,
  DEMO_VOUT,
} from "./facilitator.js";
import type { DemoLogger } from "./server.js";

export function createPaymentClient(
  logger: DemoLogger = () => undefined,
  signer: XecSigner = createDemoSigner(logger),
): AxiosInstance {
  const client = axios.create({ proxy: false });

  client.interceptors.response.use(undefined, (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 402) {
      logger("received 402");
    }
    return Promise.reject(error);
  });

  return withX402XecPaymentInterceptor(client, {
    signer,
    maxPaymentSats: 1_000n,
    now: () => DEMO_NOW,
  });
}

export function createOfflinePaymentClient(
  logger: DemoLogger = () => undefined,
  onPrepared: (result: PaymentPreparationResult) => void = () => undefined,
): AxiosInstance {
  const client = axios.create({ proxy: false });
  const mockSigner = createTestOnlyMockXecSigner({ payer: DEMO_PAYER });
  const preparer = new OfflinePaymentPreparer({
    utxoProvider: new StaticUtxoProvider([{
      txid: "2".repeat(64),
      outIdx: 1,
      sats: "10000",
      outputScript: DEMO_SOURCE_SCRIPT,
    }]),
    signatureProvider: mockSigner,
    payer: DEMO_PAYER,
    changeAddress: DEMO_PAYER,
    signatoryForUtxo: () => (
      P2PKHSignatory(DEMO_SECRET_KEY, DEMO_PUBLIC_KEY, ALL_BIP143)
    ),
    maxPaymentSats: 1_000n,
    now: () => DEMO_NOW,
  });

  client.interceptors.response.use(undefined, (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 402) {
      logger("received 402");
    }
    return Promise.reject(error);
  });

  return withX402XecPaymentInterceptor(client, {
    paymentPreparer: {
      async prepare(request) {
        const result = await preparer.prepare(request);
        onPrepared(result);
        logger("prepared PAYMENT-SIGNATURE and rawTx offline");
        return result;
      },
    },
    maxPaymentSats: 1_000n,
    now: () => DEMO_NOW,
  });
}

export function createDemoSigner(logger: DemoLogger = () => undefined): XecSigner {
  const signer = createTestOnlyMockXecSigner({
    payer: DEMO_PAYER,
    transaction: { txid: DEMO_TXID, vout: DEMO_VOUT },
  });
  return {
    payer: signer.payer,
    transaction: signer.transaction,
    async sign(message: string): Promise<string> {
      const signature = await signer.sign(message);
      logger("generated PAYMENT-SIGNATURE");
      return signature;
    },
  };
}
