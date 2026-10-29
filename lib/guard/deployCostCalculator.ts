export interface DeployCostInput {
  uploadWasm: boolean;
  wasmBytes: number;
  contractInstanceBytes: number;
  accountBalanceXlm: string | number;
}

export interface DeployCostBreakdown {
  baseFeeXlm: string;
  wasmUploadFeeXlm: string;
  contractInstanceFeeXlm: string;
  initialRentDepositXlm: string;
  totalRequiredXlm: string;
  requiredXlm: string;
  balanceXlm: string;
  balanceAfterRequiredXlm: string;
  balanceAfterRequired: string;
  safetyBufferXlm: string;
  warning: boolean;
  baseFeeXlmToStroops: bigint;
  wasmUploadFeeXlmToStroops: bigint;
  contractInstanceFeeXlmToStroops: bigint;
  initialRentDepositXlmToStroops: bigint;
  totalRequiredXlmToStroops: bigint;
  sourceNote?: string;
}

const STROOPS_PER_XLM = 10_000_000n;

const BASE_TRANSACTION_FEE_STROOPS = 100_000n;
const WASM_UPLOAD_FEE_STROOPS = 6_000_000n;
const CONTRACT_INSTANCE_FEE_STROOPS = 2_500_000n;
const INITIAL_RENT_DEPOSIT_STROOPS = 10_000_000n;

function normalizeNumericString(value: string | number): string {
  const raw = typeof value === "number" ? value.toString() : String(value).trim();
  if (raw === "") return "0";
  return raw.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function decimalToStroops(value: string | number): bigint {
  const raw = normalizeNumericString(value);
  if (raw === "") return 0n;
  const [whole, fraction = ""] = raw.split(".");
  const sign = raw.startsWith("-") ? -1n : 1n;
  const normalizedWhole = (whole ?? "").replace("-", "") || "0";
  const fracPart = (fraction + "0000000").slice(0, 7);
  const unsigned = BigInt(normalizedWhole) * STROOPS_PER_XLM + BigInt(fracPart || "0");
  return sign * unsigned;
}

function stroopsToDecimal(stroops: bigint): string {
  const sign = stroops < 0n ? "-" : "";
  const absolute = stroops < 0n ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = absolute % STROOPS_PER_XLM;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(7, "0")}`;
}

function addDecimalStrings(left: string, right: string): string {
  return stroopsToDecimal(decimalToStroops(left) + decimalToStroops(right));
}

function subtractDecimalStrings(left: string, right: string): string {
  return stroopsToDecimal(decimalToStroops(left) - decimalToStroops(right));
}

function compareDecimalStrings(left: string, right: string): number {
  const diff = decimalToStroops(left) - decimalToStroops(right);
  if (diff < 0n) return -1;
  if (diff > 0n) return 1;
  return 0;
}
function computeInitialRentDeposit(input: DeployCostInput): string {
  if (!input.uploadWasm) return "0.0000000";
  const perByteRent = 25_375n;
  const bytes = BigInt(Math.max(0, input.contractInstanceBytes));
  const extraStroops = (bytes * perByteRent) / 1_000n;
  return stroopsToDecimal(INITIAL_RENT_DEPOSIT_STROOPS + extraStroops);
}

function computeInitialRentDepositStroops(input: DeployCostInput): bigint {
  if (!input.uploadWasm) return 0n;
  const perByteRent = 25_375n;
  const bytes = BigInt(Math.max(0, input.contractInstanceBytes));
  return INITIAL_RENT_DEPOSIT_STROOPS + (bytes * perByteRent) / 1_000n;
}

function computeStroopsBreakdown(input: DeployCostInput): {
  baseFeeXlmToStroops: bigint;
  wasmUploadFeeXlmToStroops: bigint;
  contractInstanceFeeXlmToStroops: bigint;
  initialRentDepositXlmToStroops: bigint;
  totalRequiredXlmToStroops: bigint;
} {
  const baseFeeXlmToStroops = BASE_TRANSACTION_FEE_STROOPS;
  const wasmUploadFeeXlmToStroops = input.uploadWasm ? WASM_UPLOAD_FEE_STROOPS : 0n;
  const contractInstanceFeeXlmToStroops = CONTRACT_INSTANCE_FEE_STROOPS;
  const initialRentDepositXlmToStroops = computeInitialRentDepositStroops(input);
  const totalRequiredXlmToStroops = BigInt(
    baseFeeXlmToStroops +
      wasmUploadFeeXlmToStroops +
      contractInstanceFeeXlmToStroops +
      initialRentDepositXlmToStroops,
  );

  return {
    baseFeeXlmToStroops,
    wasmUploadFeeXlmToStroops,
    contractInstanceFeeXlmToStroops,
    initialRentDepositXlmToStroops,
    totalRequiredXlmToStroops,
  };
}

export function calculateDeployCost(input: DeployCostInput): DeployCostBreakdown {
  const stroopsBreakdown = computeStroopsBreakdown(input);
  const baseFeeXlm = stroopsToDecimal(BASE_TRANSACTION_FEE_STROOPS);
  const wasmUploadFeeXlm = input.uploadWasm
    ? stroopsToDecimal(WASM_UPLOAD_FEE_STROOPS)
    : "0.0000000";
  const contractInstanceFeeXlm = stroopsToDecimal(CONTRACT_INSTANCE_FEE_STROOPS);
  const initialRentDepositXlm = computeInitialRentDeposit(input);

  const totalRequiredXlm = addDecimalStrings(
    addDecimalStrings(addDecimalStrings(baseFeeXlm, wasmUploadFeeXlm), contractInstanceFeeXlm),
    initialRentDepositXlm,
  );
  const balanceXlm = normalizeNumericString(input.accountBalanceXlm ?? "0");
  const balanceAfterRequiredXlm = subtractDecimalStrings(balanceXlm, totalRequiredXlm);
  const safetyBufferXlm = "2";
  const warning =
    compareDecimalStrings(balanceXlm, addDecimalStrings(totalRequiredXlm, safetyBufferXlm)) < 0;

  // Determine source note based on warning state
  let sourceNote: string | undefined;
  if (warning) {
    sourceNote = `Balance is below the reserve safety threshold (${safetyBufferXlm} XLM cushion): fund at least ${(Number(totalRequiredXlm) + Number(safetyBufferXlm)).toFixed(7)} XLM before signing. Fees are estimates based on current network conditions and may vary at signing time.`;
  } else {
    sourceNote = `Fees are estimates based on current network conditions and may vary at signing time.`;
  }

  return {
    baseFeeXlm,
    wasmUploadFeeXlm,
    contractInstanceFeeXlm,
    initialRentDepositXlm,
    totalRequiredXlm,
    requiredXlm: totalRequiredXlm,
    balanceXlm,
    balanceAfterRequiredXlm,
    balanceAfterRequired: balanceAfterRequiredXlm,
    safetyBufferXlm,
    warning,
    baseFeeXlmToStroops: stroopsBreakdown.baseFeeXlmToStroops,
    wasmUploadFeeXlmToStroops: stroopsBreakdown.wasmUploadFeeXlmToStroops,
    contractInstanceFeeXlmToStroops: stroopsBreakdown.contractInstanceFeeXlmToStroops,
    initialRentDepositXlmToStroops: stroopsBreakdown.initialRentDepositXlmToStroops,
    totalRequiredXlmToStroops: stroopsBreakdown.totalRequiredXlmToStroops,
    sourceNote,
  };
}

export function deployCostBreakdown(input: DeployCostInput): DeployCostBreakdown {
  return calculateDeployCost(input);
}
