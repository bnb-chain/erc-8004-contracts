import hre from "hardhat";
import { encodeFunctionData, Hex, keccak256 } from "viem";
import dotenv from "dotenv";

dotenv.config();

/**
 * OOv3Evaluator Proxy address on BSC Testnet
 */
const OOV3_EVALUATOR_PROXY = "0x283d858244932664bd69eb7FE3b1587b84B14be8" as const;

/**
 * Upgrade OOv3Evaluator to fix the IOptimisticOracleV3.Assertion struct mismatch
 * 
 * The bug: The original interface defined a 4-field Assertion struct, but the
 * actual UMA OOv3 returns a 12+ field struct. This caused getAssertionInfo(),
 * getLivenessEnd(), and isSettleable() to revert.
 * 
 * The fix: Updated the interface to match the actual OOv3 return type.
 * 
 * Prerequisites:
 *   - OWNER_PRIVATE_KEY in .env (owner of OOv3Evaluator proxy)
 *   - Compiled contracts (npx hardhat compile)
 */
async function main() {
  const { viem } = await hre.network.connect();
  const publicClient = await viem.getPublicClient();

  console.log("=".repeat(60));
  console.log("Upgrading OOv3EvaluatorUpgradeable");
  console.log("=".repeat(60));
  console.log("");

  // Get owner wallet from environment
  let ownerPrivateKey = process.env.OWNER_PRIVATE_KEY;
  if (!ownerPrivateKey) {
    throw new Error("OWNER_PRIVATE_KEY not found. Add it to .env file.");
  }

  if (!ownerPrivateKey.startsWith("0x")) {
    ownerPrivateKey = `0x${ownerPrivateKey}`;
  }

  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const ownerAccount = privateKeyToAccount(ownerPrivateKey as `0x${string}`);
  const ownerWallet = createWalletClient({
    account: ownerAccount,
    chain: (await viem.getPublicClient()).chain,
    transport: http(),
  });

  console.log("Owner address:", ownerAccount.address);
  console.log("Proxy address:", OOV3_EVALUATOR_PROXY);
  console.log("");

  // Check current owner
  const proxyAddress = OOV3_EVALUATOR_PROXY as `0x${string}`;
  const currentOwner = await publicClient.readContract({
    address: proxyAddress,
    abi: [{ name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "owner",
  });

  if (currentOwner.toLowerCase() !== ownerAccount.address.toLowerCase()) {
    throw new Error(`Owner mismatch! Expected ${ownerAccount.address}, got ${currentOwner}`);
  }
  console.log("✓ Owner verified");

  // Check current version
  const currentVersion = await publicClient.readContract({
    address: proxyAddress,
    abi: [{ name: "VERSION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "VERSION",
  });
  console.log("Current VERSION:", currentVersion.toString());

  // Get current implementation
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const currentImpl = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: implSlot as `0x${string}`,
  });
  const currentImplAddress = currentImpl ? `0x${currentImpl.slice(-40)}` : "unknown";
  console.log("Current implementation:", currentImplAddress);
  console.log("");

  // Deploy new implementation
  console.log("Deploying new OOv3EvaluatorUpgradeable implementation...");
  
  const artifact = await hre.artifacts.readArtifact("OOv3EvaluatorUpgradeable");
  
  const deployTxHash = await ownerWallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
  });
  
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  const newImplAddress = deployReceipt.contractAddress;
  
  if (!newImplAddress) {
    throw new Error("Failed to deploy new implementation");
  }
  
  console.log("✓ New implementation deployed:", newImplAddress);
  console.log("  Transaction:", deployTxHash);
  console.log("");

  // Upgrade proxy to new implementation
  console.log("Upgrading proxy to new implementation...");
  
  const upgradeData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "upgradeToAndCall",
    args: [newImplAddress, "0x"], // Empty data - no reinitialization needed
  });

  const upgradeTxHash = await ownerWallet.sendTransaction({
    to: proxyAddress,
    data: upgradeData,
  });

  await publicClient.waitForTransactionReceipt({ hash: upgradeTxHash });
  console.log("✓ Proxy upgraded");
  console.log("  Transaction:", upgradeTxHash);
  console.log("");

  // Verify upgrade
  const newVersion = await publicClient.readContract({
    address: proxyAddress,
    abi: [{ name: "VERSION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "VERSION",
  });
  
  const newImpl = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: implSlot as `0x${string}`,
  });
  const newImplAddressVerified = newImpl ? `0x${newImpl.slice(-40)}` : "unknown";

  console.log("=".repeat(60));
  console.log("UPGRADE COMPLETE");
  console.log("=".repeat(60));
  console.log("");
  console.log("New VERSION:", newVersion.toString());
  console.log("New implementation:", newImplAddressVerified);
  console.log("");
  console.log("The fix:");
  console.log("  - IOptimisticOracleV3.Assertion struct now matches actual OOv3");
  console.log("  - getAssertionInfo(), getLivenessEnd(), isSettleable() should work");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
