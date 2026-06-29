import {
  createTestOnlyMockXecSigner,
  withX402XecPaymentInterceptor,
  type XecSigner,
} from "@x402-xec/axios";
import axios, { type AxiosInstance } from "axios";
import { DEMO_NOW, DEMO_PAYER, DEMO_TXID, DEMO_VOUT } from "./facilitator.js";
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
