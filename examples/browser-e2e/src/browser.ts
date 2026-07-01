import { withX402XecPaymentInterceptor } from "@x402-xec/axios";
import type { BrowserWalletAdapter } from "@x402-xec/payments";
import axios from "axios";
import {
  BrowserDryRunPaymentOrchestrator,
  createFakeTonalliWallet,
  type DemoFlowEvent,
} from "./demo-orchestrator.js";

interface DemoWindow extends Window {
  tonalli: BrowserWalletAdapter;
}

const output = requiredElement("output");
const button = requiredElement("get-weather") as HTMLButtonElement;

function log(message: string): void {
  output.textContent += `${message}\n`;
  console.log(message);
}

const wallet = createFakeTonalliWallet({
  onEvent: (event: DemoFlowEvent) => log(event),
});
Object.defineProperty(window, "tonalli", {
  value: wallet,
  configurable: false,
  enumerable: true,
  writable: false,
});

const client = axios.create();
client.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 402) {
    log("received 402");
  }
  return Promise.reject(error);
});
client.interceptors.request.use((config) => {
  if (config.headers.has("PAYMENT-SIGNATURE")) {
    log("retry sent with PAYMENT-SIGNATURE");
  }
  return config;
});
withX402XecPaymentInterceptor(client, {
  orchestrator: new BrowserDryRunPaymentOrchestrator(
    (window as unknown as DemoWindow).tonalli,
  ),
  enableOrchestratorPayments: true,
  maxPaymentSats: "1000",
  now: () => 1_800_000_000,
});

button.addEventListener("click", async () => {
  output.textContent = "";
  button.disabled = true;
  try {
    const response = await client.get("/api/weather");
    log(`protected resource returned: ${JSON.stringify(response.data)}`);
    log("broadcasted: false / DRY RUN ONLY");
  } catch (error) {
    log(`demo stopped: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    button.disabled = false;
  }
});

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}
