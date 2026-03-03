/**
 * E2E test for ServiceManager on BNB Chain testnet with real OOv3 sandbox.
 *
 * Prerequisites:
 *   1. ServiceManager deployed (run deploy-service-manager.ts first)
 *   2. Identity Registry with at least one registered agent
 *   3. Environment variables set:
 *      - BSC_TESTNET_RPC_URL
 *      - BSC_TESTNET_PRIVATE_KEY (deployer/owner wallet)
 *      - SERVICE_MANAGER_ADDRESS (proxy address from deploy)
 *      - IDENTITY_REGISTRY_ADDRESS
 *
 * UMA sandbox contracts (already deployed on BNB testnet):
 *   OOV3:         0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709
 *   TEST_TOKEN:   0xBA3219b3a40bfbA967A3ca2fC37C1aCDcE81be39
 *   MOCK_ORACLE:  0x9d50A061CAea3Fc8a891cF828E860d2E2F8Bb231
 *
 * Usage:
 *   npx hardhat run scripts/test-service-manager-e2e.ts --network bscTestnet
 */

import { network } from "hardhat";
import { keccak256, toHex, encodeFunctionData, parseAbi } from "viem";

const UMA = {
  OOV3: "0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709" as const,
  TEST_TOKEN: "0xBA3219b3a40bfbA967A3ca2fC37C1aCDcE81be39" as const,
  MOCK_ORACLE: "0x9d50A061CAea3Fc8a891cF828E860d2E2F8Bb231" as const,
};

async function main() {
  const smAddress = process.env.SERVICE_MANAGER_ADDRESS;
  if (!smAddress) throw new Error("Set SERVICE_MANAGER_ADDRESS env var");

  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const account = wallet.account.address;

  console.log(`\n=== E2E Test: ServiceManager ===`);
  console.log(`Account:          ${account}`);
  console.log(`ServiceManager:   ${smAddress}`);

  const sm = await viem.getContractAt("ServiceManager", smAddress as `0x${string}`);
  const token = await viem.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", UMA.TEST_TOKEN);

  // -- Setup: Mint test tokens --
  console.log("\n[Setup] Minting test tokens...");
  const testTokenAbi = parseAbi(["function allocateTo(address, uint256) external"]);
  await wallet.writeContract({
    address: UMA.TEST_TOKEN,
    abi: testTokenAbi,
    functionName: "allocateTo",
    args: [account, BigInt(1000e18)],
  });

  const balance = await token.read.balanceOf([account]);
  console.log(`  Token balance: ${balance}`);

  // -- Step 1: Register an agent (use Identity Registry) --
  const idRegAddr = await sm.read.getIdentityRegistry();
  console.log(`\n[1] Identity Registry: ${idRegAddr}`);

  const idReg = await viem.getContractAt("IdentityRegistryUpgradeable", idRegAddr as `0x${string}`);
  const regTx = await idReg.write.register(["ipfs://test-agent-e2e"]);
  const regReceipt = await publicClient.getTransactionReceipt({ hash: regTx });
  const registeredLog = regReceipt.logs.find(
    (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
  );
  if (!registeredLog?.topics[1]) throw new Error("Agent registration failed");
  const agentId = BigInt(registeredLog.topics[1]);
  console.log(`  Registered agent ID: ${agentId}`);

  // -- Step 2: Approve + Create Job --
  const minFee = await sm.read.minServiceFee();
  const jobAmount = minFee > 0n ? minFee * 2n : BigInt(10e18);
  console.log(`\n[2] Creating job with amount: ${jobAmount}`);

  const requestContent = "Translate 'hello world' to Chinese";
  const requestHash = keccak256(toHex(requestContent));

  await token.write.approve([smAddress as `0x${string}`, jobAmount]);
  const createTx = await sm.write.createJobAndLock([agentId, requestHash, jobAmount]);
  const createReceipt = await publicClient.getTransactionReceipt({ hash: createTx });

  const jobCreatedTopic = keccak256(toHex("JobCreated(uint256,address,uint256,uint256,bytes32)"));
  const jobLog = createReceipt.logs.find((l) => l.topics[0] === jobCreatedTopic);
  if (!jobLog?.topics[1]) throw new Error("JobCreated event not found");
  const jobId = BigInt(jobLog.topics[1]);
  console.log(`  Job created: #${jobId}`);

  // -- Step 3: Accept Job (as agent owner = same wallet) --
  console.log(`\n[3] Accepting job #${jobId}...`);
  await sm.write.acceptJob([jobId]);
  const jobAfterAccept = await sm.read.getJob([jobId]);
  console.log(`  Phase after accept: ${jobAfterAccept.phase} (expected: 2 = InProgress)`);

  // -- Step 4: Submit Result --
  console.log(`\n[4] Submitting result for job #${jobId}...`);
  const responseContent = "你好世界";
  const responseHash = keccak256(toHex(responseContent));
  const resultHash = keccak256(toHex(JSON.stringify({
    version: "1.0",
    job_id: Number(jobId),
    request: { content: requestContent },
    response: { content: responseContent },
  })));
  const dataUrl = "ipfs://QmTestE2E";

  await sm.write.submitResult([jobId, resultHash, responseHash, dataUrl]);
  const jobAfterSubmit = await sm.read.getJob([jobId]);
  console.log(`  Phase after submit: ${jobAfterSubmit.phase} (expected: 3 = Asserting)`);
  console.log(`  Assertion ID: ${jobAfterSubmit.assertionId}`);
  console.log(`  Assertion Bond: ${jobAfterSubmit.assertionBond}`);

  // -- Step 5: Wait for liveness and settle --
  const liveness = await sm.read.oov3Liveness();
  console.log(`\n[5] Waiting for OOv3 liveness (${liveness}s)...`);
  console.log(`  (In production this would be 24h. Sandbox uses ${liveness}s)`);

  const waitMs = (Number(liveness) + 10) * 1000;
  console.log(`  Sleeping ${waitMs / 1000}s...`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  console.log(`  Calling settleAssertion...`);
  await sm.write.settleAssertion([jobId]);

  const jobFinal = await sm.read.getJob([jobId]);
  console.log(`\n=== Result ===`);
  console.log(`  Phase:      ${jobFinal.phase} (expected: 5 = Completed)`);
  console.log(`  Settlement: ${jobFinal.settlement} (expected: 1 = Unchallenged)`);

  const finalBalance = await token.read.balanceOf([account]);
  console.log(`  Final token balance: ${finalBalance}`);

  if (jobFinal.phase === 5 && jobFinal.settlement === 1) {
    console.log("\n  E2E TEST PASSED: Job completed with Unchallenged settlement.");
  } else {
    console.log("\n  E2E TEST FAILED: Unexpected final state.");
  }
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
