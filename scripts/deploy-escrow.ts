/**
 * Upgrade EscrowUpgradeable from an old version to V3 (Job lifecycle version).
 *
 * Old version: feat/bsc branch - lockPayment/releasePayment only.
 * New version: current code - full Job lifecycle + UMA OOv3 dispute resolution.
 *
 * Steps:
 * 1. Deploy new EscrowUpgradeable implementation.
 * 2. Call upgradeToAndCall with initializeV3 to enable V3 features.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-escrow.ts --network bscTestnet
 *
 * Environment variables (in .env):
 *   OWNER_PRIVATE_KEY=0x...           # Required: contract owner private key
 *   ESCROW_ADDRESS=0x...              # Optional: Escrow proxy address (has default)
 *   OOV3_ADDRESS=0x...                # Optional: UMA OOv3 address (has default)
 *   PAYMENT_TOKEN_ADDRESS=0x...       # Optional: payment token address (has default)
 *   ACCEPT_TIMEOUT=3600               # Optional: accept timeout (seconds)
 *   SUBMIT_TIMEOUT=86400              # Optional: submit timeout (seconds)
 *   OOV3_LIVENESS=3600                # Optional: challenge period (seconds)
 *   BOND_RATE=1000                    # Optional: bond rate (basis points)
 */

import hre from "hardhat";
import { encodeFunctionData } from "viem";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// Config - from env, supports .env
// =============================================================================

/** Escrow proxy contract address */
const ESCROW_PROXY = (process.env.ESCROW_ADDRESS ||
  "0x8004E0cA46642eC983e5ec537687CB36F9E46351") as `0x${string}`;

/** Identity Registry address (for agent validation) */
const IDENTITY_REGISTRY = (process.env.IDENTITY_REGISTRY_ADDRESS ||
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;

/** UMA OOv3 contract address (e.g. BSC Testnet) */
const OOV3_ADDRESS = (process.env.OOV3_ADDRESS ||
  "0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709") as `0x${string}`;

/** Payment token address - e.g. TUSD (BSC Testnet) */
const PAYMENT_TOKEN = (process.env.PAYMENT_TOKEN_ADDRESS ||
  "0xBA3219b3a40bfbA967A3ca2fC37C1aCDcE81be39") as `0x${string}`;

/** Agent accept timeout (seconds) - default 1 hour */
const ACCEPT_TIMEOUT = BigInt(process.env.ACCEPT_TIMEOUT || "3600");

/** Agent submit timeout (seconds) - default 24 hours */
const SUBMIT_TIMEOUT = BigInt(process.env.SUBMIT_TIMEOUT || "86400");

/** OOv3 liveness / challenge period (seconds) - default 1 hour */
const OOV3_LIVENESS = BigInt(process.env.OOV3_LIVENESS || "3600");

/** Bond rate (basis points) - 1000 = 10% */
const BOND_RATE = BigInt(process.env.BOND_RATE || "1000");

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();

  console.log("=".repeat(70));
  console.log("EscrowUpgradeable upgrade script - upgrade to V3");
  console.log("=".repeat(70));
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 0: Validate owner private key
  // ---------------------------------------------------------------------------

  let ownerPrivateKey = process.env.OWNER_PRIVATE_KEY;
  if (!ownerPrivateKey) {
    console.error("Error: OWNER_PRIVATE_KEY is not set.");
    console.error("Set in .env: OWNER_PRIVATE_KEY=0x...");
    process.exit(1);
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

  console.log("Config:");
  console.log("  Owner:           ", ownerAccount.address);
  console.log("  Escrow proxy:    ", ESCROW_PROXY);
  console.log("  Identity:        ", IDENTITY_REGISTRY);
  console.log("  OOv3:            ", OOV3_ADDRESS);
  console.log("  Payment token:   ", PAYMENT_TOKEN);
  console.log("  Accept timeout: ", ACCEPT_TIMEOUT.toString(), "s");
  console.log("  Submit timeout:  ", SUBMIT_TIMEOUT.toString(), "s");
  console.log("  OOv3 liveness:   ", OOV3_LIVENESS.toString(), "s");
  console.log(
    "  Bond rate:       ",
    BOND_RATE.toString(),
    "bp (",
    Number(BOND_RATE) / 100,
    "%)",
  );
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 1: Check current implementation
  // ---------------------------------------------------------------------------

  console.log("Step 1: Checking current contract state...");

  const implSlot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const currentImplRaw = await publicClient.getStorageAt({
    address: ESCROW_PROXY,
    slot: implSlot as `0x${string}`,
  });
  const currentImpl = currentImplRaw
    ? `0x${currentImplRaw.slice(-40)}`
    : "unknown";

  console.log("  Current implementation:", currentImpl);

  try {
    const oov3Result = await publicClient.readContract({
      address: ESCROW_PROXY,
      abi: [
        {
          name: "oov3",
          type: "function",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ],
      functionName: "oov3",
    });
    if (
      oov3Result &&
      oov3Result !== "0x0000000000000000000000000000000000000000"
    ) {
      console.log(
        "  Contract appears already initialized for V3 (oov3 =",
        oov3Result,
        ")",
      );
      console.log("  Confirm if you really need to upgrade again.");
    }
  } catch {
    console.log("  Current version has no oov3(); upgrade to V3 required.");
  }
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 2: Compile and deploy new implementation
  // ---------------------------------------------------------------------------

  console.log("Step 2: Deploying new EscrowUpgradeable implementation...");

  const escrowArtifact = await hre.artifacts.readArtifact("EscrowUpgradeable");

  const newImpl = await viem.deployContract("EscrowUpgradeable");
  const newImplAddress = newImpl.address;

  if (!newImplAddress) {
    console.error("Deployment failed: no contract address returned.");
    process.exit(1);
  }

  console.log("  New implementation deployed:", newImplAddress);
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 3: Encode initializeV3 call data
  // ---------------------------------------------------------------------------

  console.log("Step 3: Preparing upgrade data...");

  const initializeV3Data = encodeFunctionData({
    abi: escrowArtifact.abi,
    functionName: "initializeV3",
    args: [
      OOV3_ADDRESS,
      PAYMENT_TOKEN,
      ACCEPT_TIMEOUT,
      SUBMIT_TIMEOUT,
      OOV3_LIVENESS,
      BOND_RATE,
    ],
  });

  console.log("  initializeV3 calldata encoded.");
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 4: Execute upgradeToAndCall
  // ---------------------------------------------------------------------------

  console.log("Step 4: Executing upgradeToAndCall...");
  console.log("  New implementation:", newImplAddress);
  console.log("  Will call initializeV3 to enable V3.");

  const upgradeData = encodeFunctionData({
    abi: [
      {
        name: "upgradeToAndCall",
        type: "function",
        inputs: [
          { name: "newImplementation", type: "address" },
          { name: "data", type: "bytes" },
        ],
        outputs: [],
      },
    ],
    functionName: "upgradeToAndCall",
    args: [newImplAddress, initializeV3Data],
  });

  try {
    const upgradeTxHash = await ownerWallet.sendTransaction({
      to: ESCROW_PROXY,
      data: upgradeData,
    });

    console.log("  Transaction sent:", upgradeTxHash);
    console.log("  Waiting for confirmation...");

    const upgradeReceipt = await publicClient.waitForTransactionReceipt({
      hash: upgradeTxHash,
    });

    if (upgradeReceipt.status === "success") {
      console.log("  Upgrade succeeded.");
    } else {
      console.error("  Upgrade failed: transaction reverted.");
      process.exit(1);
    }
  } catch (error) {
    console.error("  Upgrade failed:", error);
    process.exit(1);
  }
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 5: Verify upgrade
  // ---------------------------------------------------------------------------

  console.log("Step 5: Verifying upgrade...");

  const newImplRaw = await publicClient.getStorageAt({
    address: ESCROW_PROXY,
    slot: implSlot as `0x${string}`,
  });
  const verifiedImpl = newImplRaw ? `0x${newImplRaw.slice(-40)}` : "unknown";
  console.log("  Implementation after upgrade:", verifiedImpl);

  try {
    const oov3 = await publicClient.readContract({
      address: ESCROW_PROXY,
      abi: escrowArtifact.abi,
      functionName: "oov3",
      args: [],
    });
    console.log("  oov3:", oov3);
  } catch {
    console.log("  oov3: (read failed or not in ABI)");
  }

  try {
    const paymentToken = await publicClient.readContract({
      address: ESCROW_PROXY,
      abi: escrowArtifact.abi,
      functionName: "paymentToken",
      args: [],
    });
    console.log("  paymentToken:", paymentToken);
  } catch {
    console.log("  paymentToken: (read failed or not in ABI)");
  }

  try {
    const minServiceFee = await publicClient.readContract({
      address: ESCROW_PROXY,
      abi: escrowArtifact.abi,
      functionName: "minServiceFee",
      args: [],
    });
    console.log(
      "  minServiceFee:",
      minServiceFee,
      "wei (",
      Number(minServiceFee) / 1e18,
      "tokens)",
    );
  } catch {
    console.log("  minServiceFee: (read failed or not in ABI)");
  }

  try {
    const nextJobId = await publicClient.readContract({
      address: ESCROW_PROXY,
      abi: escrowArtifact.abi,
      functionName: "nextJobId",
      args: [],
    });
    console.log("  nextJobId:", nextJobId);
  } catch {
    console.log("  nextJobId: (read failed or not in ABI)");
  }

  console.log("");
  console.log("=".repeat(70));
  console.log("Upgrade complete.");
  console.log("=".repeat(70));
  console.log("");
  console.log("Summary:");
  console.log("  Escrow proxy (unchanged): ", ESCROW_PROXY);
  console.log("  Previous implementation:  ", currentImpl);
  console.log("  New implementation:      ", newImplAddress);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify the new implementation on the block explorer.");
  console.log("  2. Run integration tests.");
  console.log("  3. Update SDK ABI if needed.");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
