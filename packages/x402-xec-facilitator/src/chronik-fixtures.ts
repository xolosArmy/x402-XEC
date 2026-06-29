import type {
  ChronikTransaction,
  FundingOutpoint,
} from "@x402-xec/core";

export const FIXTURE_TXID = "c".repeat(64);
export const MISSING_FIXTURE_TXID = "d".repeat(64);
export const FIXTURE_OUTPUT_SCRIPT = `76a914${"11".repeat(20)}88ac`;
export const WRONG_FIXTURE_OUTPUT_SCRIPT = `76a914${"22".repeat(20)}88ac`;
export const FIXTURE_AMOUNT_SATS = 1_000n;

export interface ChronikInspectionFixture {
  readonly fundingOutpoint: FundingOutpoint;
  readonly outputScript: string;
  readonly amountSats: bigint;
  readonly transactions: readonly ChronikTransaction[];
}

const confirmedBlock = {
  height: 800_000,
  hash: "a".repeat(64),
  timestamp: 1_700_000_000,
} as const;

const validTransaction: ChronikTransaction = {
  txid: FIXTURE_TXID,
  outputs: [{ sats: 2_000n, outputScript: FIXTURE_OUTPUT_SCRIPT }],
  block: confirmedBlock,
  isFinal: true,
};

function fixture(
  transactions: readonly ChronikTransaction[],
  fundingOutpoint: FundingOutpoint = { txid: FIXTURE_TXID, outIdx: 0 },
): ChronikInspectionFixture {
  return {
    fundingOutpoint,
    outputScript: FIXTURE_OUTPUT_SCRIPT,
    amountSats: FIXTURE_AMOUNT_SATS,
    transactions,
  };
}

export const validFundingFixture = fixture([validTransaction]);

export const missingTransactionFixture = fixture([], {
  txid: MISSING_FIXTURE_TXID,
  outIdx: 0,
});

export const wrongOutIdxFixture = fixture([validTransaction], {
  txid: FIXTURE_TXID,
  outIdx: 1,
});

export const wrongPayToFixture = fixture([{
  ...validTransaction,
  outputs: [{ sats: 2_000n, outputScript: WRONG_FIXTURE_OUTPUT_SCRIPT }],
}]);

export const insufficientSatsFixture = fixture([{
  ...validTransaction,
  outputs: [{ sats: 999n, outputScript: FIXTURE_OUTPUT_SCRIPT }],
}]);

export const tokenOutputFixture = fixture([{
  ...validTransaction,
  outputs: [{
    sats: 2_000n,
    outputScript: FIXTURE_OUTPUT_SCRIPT,
    token: { tokenId: "e".repeat(64), atoms: 1n, isMintBaton: false },
  }],
}]);

export const unfinalizedTransactionFixture = fixture([{
  txid: FIXTURE_TXID,
  outputs: validTransaction.outputs,
  isFinal: false,
}]);

export const confirmedTransactionFixture = fixture([{
  txid: FIXTURE_TXID,
  outputs: validTransaction.outputs,
  block: confirmedBlock,
  isFinal: false,
}]);

export const avalancheFinalTransactionFixture = fixture([{
  txid: FIXTURE_TXID,
  outputs: validTransaction.outputs,
  isFinal: true,
}]);
