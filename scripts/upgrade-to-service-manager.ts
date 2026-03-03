/**
 * Upgrade an existing EscrowUpgradeable proxy to ServiceManager.
 *
 * This script:
 *   1. Deploys the new ServiceManager implementation
 *   2. Calls upgradeToAndCall on the existing proxy to switch implementation + initializeV3
 *   3. Calls setIdentityRegistry to set the Identity Registry address
 *   4. Verifies the upgrade
 *
 * Required environment variables:
 *   ESCROW_PROXY_ADDRESS    — existing EscrowUpgradeable proxy address
 *   IDENTITY_REGISTRY_ADDRESS — Identity Registry contract address
 *   BSC_TESTNET_PRIVATE_KEY — deployer/owner private key
 *   BSC_TESTNET_RPC_URL     — RPC endpoint
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-to-service-manager.ts --network bscTestnet
 */

import { network } from "hardhat";
import { encodeFunctionData } from "viem";

const SM_INIT_PARAMS = {
  acceptTimeout: 86400,       // 24 hours
  submitTimeout: 172800,      // 48 hours
  oov3Liveness: 900,          // 15 minutes (sandbox testing, mainnet use 7200+)
  bondRate: 1000,             // 10% in basis points
};

async function main() {
  const proxyAddress = process.env.ESCROW_PROXY_ADDRESS;
  if (!proxyAddress) throw new Error("Set ESCROW_PROXY_ADDRESS env var");

  const identityRegistry = process.env.IDENTITY_REGISTRY_ADDRESS;
  if (!identityRegistry) throw new Error("Set IDENTITY_REGISTRY_ADDRESS env var");

  const oov3Address = process.env.OOV3_ADDRESS;
  if (!oov3Address) throw new Error("Set OOV3_ADDRESS env var");

  const paymentTokenAddress = process.env.PAYMENT_TOKEN_ADDRESS || process.env.TEST_TOKEN_ADDRESS;
  if (!paymentTokenAddress) throw new Error("Set PAYMENT_TOKEN_ADDRESS or TEST_TOKEN_ADDRESS env var");

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log(`Deployer:        ${deployer.account.address}`);
  console.log(`Existing proxy:  ${proxyAddress}`);
  console.log(`Identity Reg:    ${identityRegistry}`);
  console.log(`OOv3:            ${oov3Address}`);
  console.log(`Payment Token:   ${paymentTokenAddress}`);

  // Step 0: Check existing proxy state
  console.log("\n[0/4] Checking existing proxy...");
  const existingEscrow = await viem.getContractAt("EscrowUpgradeable", proxyAddress as `0x${string}`);
  const currentIdReg = await existingEscrow.read.getIdentityRegistry();
  const proxyBalance = await publicClient.getBalance({ address: proxyAddress as `0x${string}` });
  console.log(`  Current Identity Registry: ${currentIdReg}`);
  console.log(`  Proxy BNB balance: ${proxyBalance} wei`);
  if (proxyBalance > 0n) {
    console.log(`  WARNING: Proxy holds ${proxyBalance} wei BNB. Use rescueETH() after upgrade to recover.`);
  }

  // Step 1: Deploy ServiceManager implementation
  console.log("\n[1/4] Deploying ServiceManager implementation...");
  const smImpl = await viem.deployContract("ServiceManager");
  console.log(`  Implementation: ${smImpl.address}`);

  // Step 2: Upgrade proxy via upgradeToAndCall
  console.log("\n[2/4] Upgrading proxy to ServiceManager...");
  const initV3Calldata = encodeFunctionData({
    abi: [{
      name: "initializeV3",
      type: "function",
      inputs: [
        { name: "oov3_", type: "address" },
        { name: "paymentToken_", type: "address" },
        { name: "acceptTimeout_", type: "uint256" },
        { name: "submitTimeout_", type: "uint256" },
        { name: "oov3Liveness_", type: "uint64" },
        { name: "bondRate_", type: "uint256" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    }],
    functionName: "initializeV3",
    args: [
      oov3Address as `0x${string}`,
      paymentTokenAddress as `0x${string}`,
      BigInt(SM_INIT_PARAMS.acceptTimeout),
      BigInt(SM_INIT_PARAMS.submitTimeout),
      BigInt(SM_INIT_PARAMS.oov3Liveness),
      BigInt(SM_INIT_PARAMS.bondRate),
    ],
  });

  // The existing proxy exposes upgradeToAndCall via UUPSUpgradeable
  const proxyAsUUPS = await viem.getContractAt("EscrowUpgradeable", proxyAddress as `0x${string}`);
  await proxyAsUUPS.write.upgradeToAndCall([smImpl.address, initV3Calldata]);
  console.log(`  Upgrade TX sent. Proxy now points to ServiceManager.`);

  // Step 3: Set Identity Registry (may have changed or been zero)
  console.log("\n[3/4] Setting Identity Registry...");
  const sm = await viem.getContractAt("ServiceManager", proxyAddress as `0x${string}`);
  await sm.write.setIdentityRegistry([identityRegistry as `0x${string}`]);
  console.log(`  Identity Registry set to: ${identityRegistry}`);

  // Step 4: Verify
  console.log("\n[4/4] Verifying upgrade...");
  const oov3Addr = await sm.read.oov3();
  const tokenAddr = await sm.read.paymentToken();
  const minFee = await sm.read.minServiceFee();
  const idReg = await sm.read.getIdentityRegistry();
  const nextId = await sm.read.nextJobId();

  console.log("\n=== ServiceManager Upgrade Complete ===");
  console.log(`  Proxy address:     ${proxyAddress}  (unchanged)`);
  console.log(`  New implementation: ${smImpl.address}`);
  console.log(`  Identity Registry: ${idReg}`);
  console.log(`  OOv3:              ${oov3Addr}`);
  console.log(`  Payment token:     ${tokenAddr}`);
  console.log(`  Min service fee:   ${minFee}`);
  console.log(`  Next job ID:       ${nextId}`);
  console.log(`  Accept timeout:    ${SM_INIT_PARAMS.acceptTimeout}s`);
  console.log(`  Submit timeout:    ${SM_INIT_PARAMS.submitTimeout}s`);
  console.log(`  OOv3 liveness:     ${SM_INIT_PARAMS.oov3Liveness}s`);
  console.log(`  Bond rate:         ${SM_INIT_PARAMS.bondRate} bps (${SM_INIT_PARAMS.bondRate / 100}%)`);

  // Check legacy functions still work
  console.log("\n--- Legacy compatibility check ---");
  try {
    await sm.read.getClientPayments([deployer.account.address]);
    console.log("  getClientPayments: OK (read-only, backward compatible)");
  } catch {
    console.log("  getClientPayments: NOT AVAILABLE");
  }

  if (proxyBalance > 0n) {
    console.log(`\n  ACTION REQUIRED: Call rescueETH(recipient, ${proxyBalance}) to recover legacy BNB.`);
  }
}

main().catch((err) => {
  console.error("Upgrade failed:", err);
  process.exit(1);
});
