export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4020;
export const DEFAULT_PUBLIC_ORIGIN = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

export interface GateH2ARuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
}

export type GateH2AEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveGateH2ARuntimeConfig(
  environment: GateH2AEnvironment,
): GateH2ARuntimeConfig {
  return {
    host: resolveHost(environment.H2A_HOST),
    port: resolvePort(environment),
    publicOrigin: environment.H2A_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN,
  };
}

function resolveHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_HOST;
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("H2A_HOST must be a non-empty host without surrounding whitespace");
  }
  return value;
}

function resolvePort(environment: GateH2AEnvironment): number {
  const source = environment.H2A_PORT !== undefined
    ? "H2A_PORT"
    : environment.PORT !== undefined
      ? "PORT"
      : undefined;
  if (source === undefined) return DEFAULT_PORT;

  const value = environment[source];
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
  return port;
}
