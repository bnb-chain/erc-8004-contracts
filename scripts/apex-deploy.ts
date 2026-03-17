import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  keccak256,
  getCreate2Address,
} from "viem";
import dotenv from "dotenv";

dotenv.config();

const SAFE_SINGLETON_FACTORY =
  "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;

/** Payment token address (U on BSC Testnet) */
const PAYMENT_TOKEN_ADDRESS =
  (process.env.PAYMENT_TOKEN_ADDRESS || "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565") as `0x${string}`;

/** Min budget for jobs */
const MIN_BUDGET = BigInt(process.env.APEX_MIN_BUDGET || "0");

/** Salt for APEX implementation (CREATE2) - v3 with owner param */
const APEX_IMPL_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000008202" as Hex;

/** Salt for APEX proxy (CREATE2) - v3 with owner param */
const APEX_PROXY_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000008203" as Hex;

async function getProxyBytecode(
  implementationAddress: string,
  initCalldata: Hex
): Promise<Hex> {
  const proxyArtifact = await hre.artifacts.readArtifact("ERC1967Proxy");
  const constructorArgs = encodeAbiParameters(
    [
      { name: "implementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    [implementationAddress as `0x${string}`, initCalldata]
  );
  return (proxyArtifact.bytecode + constructorArgs.slice(2)) as Hex;
}

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const codeAt = async (address: string) =>
    publicClient.getBytecode({ address: address as `0x${string}` });

  console.log("ERC-8183 APEX AgenticCommerce Direct Deployment (ERC-7201 compliant)");
  console.log("=".repeat(70));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("");

  // Check CREATE2 factory
  if (!(await codeAt(SAFE_SINGLETON_FACTORY))) {
    throw new Error(`CREATE2 factory not deployed at ${SAFE_SINGLETON_FACTORY}`);
  }

  // Step 1: Compute and deploy APEX implementation
  const apexImplArtifact = await hre.artifacts.readArtifact("AgenticCommerceUpgradeable");
  const apexImplBytecode = apexImplArtifact.bytecode as Hex;
  const apexImplAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: APEX_IMPL_SALT,
    bytecodeHash: keccak256(apexImplBytecode),
  });

  console.log("Computed addresses:");
  console.log("  APEX Implementation:", apexImplAddress);

  if (!(await codeAt(apexImplAddress))) {
    console.log("\n1. Deploying APEX implementation...");
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (APEX_IMPL_SALT + apexImplBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", apexImplAddress);
  } else {
    console.log("\n1. APEX implementation already deployed (skip)");
  }

  // Step 2: Compute proxy address with init data
  const apexInitData = encodeFunctionData({
    abi: apexImplArtifact.abi,
    functionName: "initialize",
    args: [deployer.account.address, PAYMENT_TOKEN_ADDRESS, MIN_BUDGET],
  });

  const apexProxyBytecode = await getProxyBytecode(apexImplAddress, apexInitData);
  const apexProxyAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: APEX_PROXY_SALT,
    bytecodeHash: keccak256(apexProxyBytecode),
  });

  console.log("  APEX Proxy:", apexProxyAddress);

  // Step 3: Deploy proxy directly pointing to AgenticCommerceUpgradeable
  if (!(await codeAt(apexProxyAddress))) {
    console.log("\n2. Deploying APEX proxy (direct to implementation)...");
    console.log("   Config:");
    console.log("     Payment Token:", PAYMENT_TOKEN_ADDRESS);
    console.log("     Min Budget:", MIN_BUDGET.toString());

    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (APEX_PROXY_SALT + apexProxyBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", apexProxyAddress);
  } else {
    console.log("\n2. APEX proxy already deployed (skip)");
  }

  // Verify
  console.log("\n" + "=".repeat(70));
  console.log("Verification:");

  const owner = await publicClient.readContract({
    address: apexProxyAddress as `0x${string}`,
    abi: [{ name: "owner", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
    functionName: "owner",
  });

  const paymentToken = await publicClient.readContract({
    address: apexProxyAddress as `0x${string}`,
    abi: [{ name: "paymentToken", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
    functionName: "paymentToken",
  });

  const nextJobId = await publicClient.readContract({
    address: apexProxyAddress as `0x${string}`,
    abi: [{ name: "nextJobId", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
    functionName: "nextJobId",
  });

  console.log("  Owner:", owner);
  console.log("  Payment Token:", paymentToken);
  console.log("  Next Job ID:", nextJobId);

  console.log("\n" + "=".repeat(70));
  console.log("Deployment complete!");
  console.log("\nUpdate these addresses in your config files:");
  console.log(`  ERC8183_ADDRESS=${apexProxyAddress}`);
  console.log(`  APEX_IMPL_ADDRESS=${apexImplAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
