/**
 * Deploy ServiceManager as a UUPS upgrade of EscrowUpgradeable.
 *
 * For fresh deployment (no existing proxy):
 *   1. Deploy HardhatMinimalUUPS as initial implementation
 *   2. Deploy ERC1967Proxy pointing to it
 *   3. Deploy ServiceManager implementation
 *   4. Upgrade proxy to ServiceManager via upgradeToAndCall(initializeV3)
 *
 * UMA OOv3 sandbox addresses (BNB Chain testnet):
 *   OOV3:       0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709
 *   TEST_TOKEN: 0xBA3219b3a40bfbA967A3ca2fC37C1aCDcE81be39
 *   MOCK_ORACLE: 0x9d50A061CAea3Fc8a891cF828E860d2E2F8Bb231
 */

import { network } from "hardhat";
import { encodeAbiParameters, encodeFunctionData } from "viem";

const UMA_SANDBOX = {
  OOV3: "0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709" as const,
  TEST_TOKEN: "0xBA3219b3a40bfbA967A3ca2fC37C1aCDcE81be39" as const,
  MOCK_ORACLE: "0x9d50A061CAea3Fc8a891cF828E860d2E2F8Bb231" as const,
};

const IDENTITY_REGISTRY = (process.env.IDENTITY_REGISTRY_ADDRESS ||
  "0x8004A818Fb3c86D291C5e3C9b8C82B0e0d4e9D98") as `0x${string}`;

const SM_INIT_PARAMS = {
  acceptTimeout: 86400,        // 24 hours
  submitTimeout: 172800,       // 48 hours
  oov3Liveness: 300,           // 5 minutes (sandbox testing)
  bondRate: 1000,              // 10% in basis points
};

async function main() {
  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log(`Deployer: ${deployer.account.address}`);

  // Step 1: Deploy MinimalUUPS (initial implementation for fresh proxy)
  console.log("\n[1/4] Deploying HardhatMinimalUUPS...");
  const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
  console.log(`  MinimalUUPS impl: ${minimalImpl.address}`);

  // Step 2: Deploy ERC1967Proxy
  console.log("\n[2/4] Deploying ERC1967Proxy...");
  const initCalldata = encodeFunctionData({
    abi: [{
      name: "initialize",
      type: "function",
      inputs: [{ name: "identityRegistry_", type: "address" }],
      outputs: [],
      stateMutability: "nonpayable",
    }],
    functionName: "initialize",
    args: ["0x0000000000000000000000000000000000000000"],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [
    minimalImpl.address,
    initCalldata,
  ]);
  console.log(`  Proxy: ${proxy.address}`);

  // Step 3: Deploy ServiceManager implementation
  console.log("\n[3/4] Deploying ServiceManager implementation...");
  const smImpl = await viem.deployContract("ServiceManager");
  console.log(`  ServiceManager impl: ${smImpl.address}`);

  // Step 4: Upgrade proxy to ServiceManager
  console.log("\n[4/4] Upgrading proxy to ServiceManager...");
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
      UMA_SANDBOX.OOV3,
      UMA_SANDBOX.TEST_TOKEN,
      BigInt(SM_INIT_PARAMS.acceptTimeout),
      BigInt(SM_INIT_PARAMS.submitTimeout),
      BigInt(SM_INIT_PARAMS.oov3Liveness),
      BigInt(SM_INIT_PARAMS.bondRate),
    ],
  });

  const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
  await minimalProxy.write.upgradeToAndCall([smImpl.address, initV3Calldata]);

  // Step 5: Set Identity Registry
  console.log("\n[5/5] Setting Identity Registry...");
  const sm = await viem.getContractAt("ServiceManager", proxy.address);
  await sm.write.setIdentityRegistry([IDENTITY_REGISTRY]);
  console.log(`  Identity Registry: ${IDENTITY_REGISTRY}`);

  // Verify
  const oov3Addr = await sm.read.oov3();
  const tokenAddr = await sm.read.paymentToken();
  const minFee = await sm.read.minServiceFee();
  const idReg = await sm.read.getIdentityRegistry();

  console.log("\n=== ServiceManager Deployed ===");
  console.log(`  Proxy address:     ${proxy.address}`);
  console.log(`  Implementation:    ${smImpl.address}`);
  console.log(`  Identity Registry: ${idReg}`);
  console.log(`  OOv3:              ${oov3Addr}`);
  console.log(`  Payment token:     ${tokenAddr}`);
  console.log(`  Min service fee:   ${minFee}`);
  console.log(`  Accept timeout:    ${SM_INIT_PARAMS.acceptTimeout}s`);
  console.log(`  Submit timeout:    ${SM_INIT_PARAMS.submitTimeout}s`);
  console.log(`  OOv3 liveness:     ${SM_INIT_PARAMS.oov3Liveness}s`);
  console.log(`  Bond rate:         ${SM_INIT_PARAMS.bondRate} bps (${SM_INIT_PARAMS.bondRate / 100}%)`);
}

main().catch(console.error);
