import hre from "hardhat";
import {
  Hex,
  keccak256,
  getCreate2Address,
} from "viem";
import dotenv from "dotenv";

dotenv.config();

const SAFE_SINGLETON_FACTORY =
  "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;

/** Current proxy address */
const PROXY_ADDRESS =
  (process.env.OOV3_EVALUATOR_ADDRESS || "0x283d858244932664bd69eb7FE3b1587b84B14be8") as `0x${string}`;

/** Salt for new implementation (CREATE2) - increment for each upgrade */
const NEW_IMPL_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000008306" as Hex;

// ERC-1967 implementation slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const codeAt = async (address: string) =>
    publicClient.getBytecode({ address: address as `0x${string}` });

  console.log("OOv3Evaluator Upgrade");
  console.log("=".repeat(70));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("");

  // Step 1: Check current state
  console.log("1. Current State:");
  console.log("   Proxy:", PROXY_ADDRESS);
  
  const currentImplSlot = await publicClient.getStorageAt({
    address: PROXY_ADDRESS,
    slot: IMPL_SLOT as `0x${string}`,
  });
  const currentImpl = "0x" + currentImplSlot?.slice(26);
  console.log("   Current Implementation:", currentImpl);

  // Check owner
  const OWNER_ABI = [
    { name: "owner", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "VERSION", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  ] as const;

  const owner = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: OWNER_ABI,
    functionName: "owner",
  });
  console.log("   Owner:", owner);

  if (owner.toLowerCase() !== deployer.account.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.account.address} is not the owner ${owner}`);
  }

  // Try to get current version (may fail if old contract doesn't have VERSION)
  try {
    const currentVersion = await publicClient.readContract({
      address: PROXY_ADDRESS,
      abi: OWNER_ABI,
      functionName: "VERSION",
    });
    console.log("   Current Version:", currentVersion.toString());
  } catch {
    console.log("   Current Version: N/A (pre-versioning)");
  }

  // Step 2: Deploy new implementation
  console.log("");
  console.log("2. Deploying New Implementation...");
  
  const implArtifact = await hre.artifacts.readArtifact("OOv3EvaluatorUpgradeable");
  const implBytecode = implArtifact.bytecode as Hex;
  const newImplAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: NEW_IMPL_SALT,
    bytecodeHash: keccak256(implBytecode),
  });

  console.log("   New Implementation:", newImplAddress);

  if (!(await codeAt(newImplAddress))) {
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (NEW_IMPL_SALT + implBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   ✓ Deployed");
  } else {
    console.log("   ✓ Already deployed (skip)");
  }

  // Step 3: Upgrade proxy
  console.log("");
  console.log("3. Upgrading Proxy...");

  const UPGRADE_ABI = [
    {
      name: "upgradeToAndCall",
      type: "function",
      inputs: [
        { name: "newImplementation", type: "address" },
        { name: "data", type: "bytes" },
      ],
      outputs: [],
      stateMutability: "payable",
    },
  ] as const;

  const upgradeTx = await deployer.writeContract({
    address: PROXY_ADDRESS,
    abi: UPGRADE_ABI,
    functionName: "upgradeToAndCall",
    args: [newImplAddress, "0x"],
  });
  await publicClient.waitForTransactionReceipt({ hash: upgradeTx });
  console.log("   ✓ Upgraded. Tx:", upgradeTx);

  // Step 4: Verify upgrade
  console.log("");
  console.log("4. Verifying Upgrade...");

  const newImplSlot = await publicClient.getStorageAt({
    address: PROXY_ADDRESS,
    slot: IMPL_SLOT as `0x${string}`,
  });
  const actualNewImpl = "0x" + newImplSlot?.slice(26);
  
  console.log("   New Implementation:", actualNewImpl);
  console.log("   Match:", actualNewImpl.toLowerCase() === newImplAddress.toLowerCase() ? "✅" : "❌");

  // Check new version
  const newVersion = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: OWNER_ABI,
    functionName: "VERSION",
  });
  console.log("   New Version:", newVersion.toString());

  // Check state preserved
  const STATE_ABI = [
    { name: "acp", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "bondBalance", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "liveness", type: "function", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  ] as const;

  const [acp, bondBalance, liveness] = await Promise.all([
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "acp" }),
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "bondBalance" }),
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "liveness" }),
  ]);

  console.log("");
  console.log("   State Preserved:");
  console.log("     ACP:", acp);
  console.log("     Bond Balance:", (BigInt(bondBalance) / BigInt(1e18)).toString(), "U");
  console.log("     Liveness:", liveness.toString(), "seconds");

  // Summary
  console.log("");
  console.log("=".repeat(70));
  console.log("Upgrade Complete!");
  console.log("=".repeat(70));
  console.log("");
  console.log("Proxy (unchanged):", PROXY_ADDRESS);
  console.log("Old Implementation:", currentImpl);
  console.log("New Implementation:", newImplAddress);
  console.log("Version:", newVersion.toString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
