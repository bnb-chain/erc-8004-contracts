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

/** Current ACP proxy address */
const PROXY_ADDRESS =
  (process.env.ACP_ADDRESS || "0x8b121FEf5e1688B976D814003f05d9366F3Fa8A3") as `0x${string}`;

/** Salt for new implementation (CREATE2) - increment for each upgrade */
// v2: setPaymentToken  |  v3: audit remediation (H01, M02, L01, I02, I03)
const NEW_IMPL_SALT =
  "0x000000000000000000000000000000000000000000000000000000000000818b" as Hex;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const codeAt = async (address: string) =>
    publicClient.getBytecode({ address: address as `0x${string}` });

  console.log("AgenticCommerce (ACP) Upgrade");
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

  // Step 2: Deploy new implementation
  console.log("");
  console.log("2. Deploying New Implementation...");
  
  const implArtifact = await hre.artifacts.readArtifact("AgenticCommerceUpgradeable");
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

  // Check state preserved
  const STATE_ABI = [
    { name: "paymentToken", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "minBudget", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "nextJobId", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  ] as const;

  const [paymentToken, minBudget, nextJobId] = await Promise.all([
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "paymentToken" }),
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "minBudget" }),
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "nextJobId" }),
  ]);

  console.log("");
  console.log("   State Preserved:");
  console.log("     Payment Token:", paymentToken);
  console.log("     Min Budget:", minBudget.toString());
  console.log("     Next Job ID:", nextJobId.toString());

  // Summary
  console.log("");
  console.log("=".repeat(70));
  console.log("Upgrade Complete!");
  console.log("=".repeat(70));
  console.log("");
  console.log("Proxy (unchanged):", PROXY_ADDRESS);
  console.log("Old Implementation:", currentImpl);
  console.log("New Implementation:", newImplAddress);
  console.log("");
  console.log("Changes in this version:");
  console.log("  - H01: _totalEscrowed tracking, rescueERC20 excess guard");
  console.log("  - M02: require _totalEscrowed == 0 in setPaymentToken");
  console.log("  - L01: safe transfer in _safePayoutOrPend");
  console.log("  - I02: claimRefund uses _safePayoutOrPend");
  console.log("  - I03: MinBudgetUpdated & TokensRescued events");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
