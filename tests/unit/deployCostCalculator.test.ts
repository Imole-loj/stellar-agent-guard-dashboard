import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateDeployCost,
  deployCostBreakdown,
  type DeployCostBreakdown,
} from "../../lib/guard/deployCostCalculator.ts";

test("deploy cost covers the protocol fee and rent minimum for an upload-and-create deploy", () => {
  const cost = calculateDeployCost({
    uploadWasm: true,
    wasmBytes: 39_673,
    contractInstanceBytes: 64,
    accountBalanceXlm: "10",
  });

  assert.equal(cost.requiredXlm, "1.8601624");
  assert.equal(cost.balanceAfterRequired, "8.1398376");
  assert.equal(cost.safetyBufferXlm, "2");
  assert.equal(cost.warning, false);

  const breakdown = deployCostBreakdown({
    uploadWasm: true,
    wasmBytes: 39_673,
    contractInstanceBytes: 64,
    accountBalanceXlm: "10",
  });

  assert.deepEqual(breakdown, {
    baseFeeXlm: "0.0100000",
    wasmUploadFeeXlm: "0.6000000",
    contractInstanceFeeXlm: "0.2500000",
    initialRentDepositXlm: "1.0001624",
    totalRequiredXlm: "1.8601624",
    requiredXlm: "1.8601624",
    balanceXlm: "10",
    balanceAfterRequiredXlm: "8.1398376",
    balanceAfterRequired: "8.1398376",
    safetyBufferXlm: "2",
    warning: false,
    baseFeeXlmToStroops: 100000n,
    wasmUploadFeeXlmToStroops: 6000000n,
    contractInstanceFeeXlmToStroops: 2500000n,
    initialRentDepositXlmToStroops: 10001624n,
    totalRequiredXlmToStroops: 18601624n,
    sourceNote:
      "Fees are estimates based on current network conditions and may vary at signing time.",
  });
});

test("a deploy with a low balance warns before the minimum reserve is reached", () => {
  const cost = calculateDeployCost({
    uploadWasm: false,
    wasmBytes: 0,
    contractInstanceBytes: 64,
    accountBalanceXlm: "1.5",
  });

  assert.equal(cost.requiredXlm, "0.2600000");
  assert.equal(cost.balanceAfterRequired, "1.2400000");
  assert.equal(cost.warning, true);
  assert.equal(cost.safetyBufferXlm, "2");
});

test("the rent schedule matches the Soroban protocol minimum for contract entries", () => {
  const cost = calculateDeployCost({
    uploadWasm: true,
    wasmBytes: 39_673,
    contractInstanceBytes: 64,
    accountBalanceXlm: "5",
  });

  assert.equal(cost.contractInstanceFeeXlm, "0.2500000");
  assert.equal(cost.initialRentDepositXlm, "1.0001624");
  assert.equal(cost.totalRequiredXlm, "1.8601624");
});
