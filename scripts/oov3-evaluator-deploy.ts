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

// Minimal ERC20 ABI for bond token operations
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "allocateTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// =============================================================================
// Configuration
// =============================================================================

/** ACP Contract Address */
const ACP_ADDRESS =
  (process.env.ACP_ADDRESS || "0x8b121FEf5e1688B976D814003f05d9366F3Fa8A3") as `0x${string}`;

/** UMA OOv3 Address (BSC Testnet) */
const OOV3_ADDRESS =
  (process.env.OOV3_ADDRESS || "0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709") as `0x${string}`;

/** Bond Token Address (U on BSC Testnet) */
const BOND_TOKEN_ADDRESS =
  (process.env.PAYMENT_TOKEN_ADDRESS || "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565") as `0x${string}`;

/** Liveness period in seconds (30 minutes) */
const LIVENESS_SECONDS = BigInt(process.env.EVALUATOR_LIVENESS || "1800");

/** Initial bond deposit (100 U with 18 decimals) */
const INITIAL_BOND_DEPOSIT = BigInt(process.env.INITIAL_BOND_DEPOSIT || "100000000000000000000");

/** Whether to deposit initial bond */
const SHOULD_DEPOSIT_BOND = process.env.SKIP_BOND_DEPOSIT !== "true";

/** Salt for implementation (CREATE2) */
const IMPL_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000008300" as Hex;

/** Salt for proxy (CREATE2) */
const PROXY_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000008301" as Hex;

// =============================================================================
// Helpers
// =============================================================================

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

// =============================================================================
// Main
// =============================================================================

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const codeAt = async (address: string) =>
    publicClient.getBytecode({ address: address as `0x${string}` });

  console.log("OOv3Evaluator Upgradeable Deployment (UUPS + ERC-7201)");
  console.log("=".repeat(70));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("");
  console.log("Configuration:");
  console.log("  ACP Address:", ACP_ADDRESS);
  console.log("  OOv3 Address:", OOV3_ADDRESS);
  console.log("  Bond Token:", BOND_TOKEN_ADDRESS);
  console.log("  Liveness:", LIVENESS_SECONDS.toString(), "seconds");
  console.log("  Initial Bond Deposit:", INITIAL_BOND_DEPOSIT.toString(), "wei");
  console.log("  Should Deposit Bond:", SHOULD_DEPOSIT_BOND);
  console.log("");

  // Verify CREATE2 factory
  if (!(await codeAt(SAFE_SINGLETON_FACTORY))) {
    throw new Error(`CREATE2 factory not deployed at ${SAFE_SINGLETON_FACTORY}`);
  }

  // Step 1: Deploy implementation
  const implArtifact = await hre.artifacts.readArtifact("OOv3EvaluatorUpgradeable");
  const implBytecode = implArtifact.bytecode as Hex;
  const implAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: IMPL_SALT,
    bytecodeHash: keccak256(implBytecode),
  });

  console.log("Computed addresses:");
  console.log("  Implementation:", implAddress);

  if (!(await codeAt(implAddress))) {
    console.log("\n1. Deploying implementation...");
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (IMPL_SALT + implBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", implAddress);
  } else {
    console.log("\n1. Implementation already deployed (skip)");
  }

  // Step 2: Deploy proxy with init data
  const initData = encodeFunctionData({
    abi: implArtifact.abi,
    functionName: "initialize",
    args: [
      deployer.account.address,
      ACP_ADDRESS,
      OOV3_ADDRESS,
      BOND_TOKEN_ADDRESS,
      LIVENESS_SECONDS,
    ],
  });

  const proxyBytecode = await getProxyBytecode(implAddress, initData);
  const proxyAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: PROXY_SALT,
    bytecodeHash: keccak256(proxyBytecode),
  });

  console.log("  Proxy:", proxyAddress);

  if (!(await codeAt(proxyAddress))) {
    console.log("\n2. Deploying proxy...");
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (PROXY_SALT + proxyBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", proxyAddress);
  } else {
    console.log("\n2. Proxy already deployed (skip)");
  }

  // Step 3: Verify deployment
  console.log("\n3. Verifying deployment...");
  
  const VERIFY_ABI = [
    { name: "acp", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "oov3", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "bondToken", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "liveness", type: "function", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
    { name: "bondBalance", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "owner", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  ] as const;

  const [acpVal, oov3Val, bondTokenVal, livenessVal, bondBalanceVal, ownerVal] = await Promise.all([
    publicClient.readContract({ address: proxyAddress, abi: VERIFY_ABI, functionName: "acp" }),
    publicClient.readContract({ address: proxyAddress, abi: VERIFY_ABI, functionName: "oov3" }),
    publicClient.readContract({ address: proxyAddress, abi: VERIFY_ABI, functionName: "bondToken" }),
    publicClient.readContract({ address: proxyAddress, abi: VERIFY_ABI, functionName: "liveness" }),
    publicClient.readContract({ address: proxyAddress, abi: VERIFY_ABI, functionName: "bondBalance" }),
    publicClient.readContract({ address: proxyAddress, abi: VERIFY_ABI, functionName: "owner" }),
  ]);

  console.log("   ACP:", acpVal);
  console.log("   OOv3:", oov3Val);
  console.log("   Bond Token:", bondTokenVal);
  console.log("   Liveness:", livenessVal.toString(), "seconds");
  console.log("   Bond Balance:", bondBalanceVal.toString(), "wei");
  console.log("   Owner:", ownerVal);

  // Step 4: Deposit initial bond
  if (SHOULD_DEPOSIT_BOND && bondBalanceVal === 0n) {
    console.log("\n4. Depositing initial bond...");

    const bondToken = {
      address: BOND_TOKEN_ADDRESS,
      abi: ERC20_ABI,
    };

    let balance = await publicClient.readContract({
      ...bondToken,
      functionName: "balanceOf",
      args: [deployer.account.address],
    });

    console.log("   Deployer balance:", balance.toString(), "wei");

    if (balance < INITIAL_BOND_DEPOSIT) {
      console.log("   Insufficient balance, minting test tokens...");
      const mintTx = await deployer.writeContract({
        ...bondToken,
        functionName: "allocateTo",
        args: [deployer.account.address, INITIAL_BOND_DEPOSIT],
      });
      await publicClient.waitForTransactionReceipt({ hash: mintTx });
      console.log("   ✓ Minted", INITIAL_BOND_DEPOSIT.toString(), "wei");
      
      balance = await publicClient.readContract({
        ...bondToken,
        functionName: "balanceOf",
        args: [deployer.account.address],
      });
      console.log("   New balance:", balance.toString(), "wei");
    }

    console.log("   Approving bond token...");
    const approveTx = await deployer.writeContract({
      ...bondToken,
      functionName: "approve",
      args: [proxyAddress, INITIAL_BOND_DEPOSIT],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log("   ✓ Approved");

    console.log("   Depositing bond...");
    const DEPOSIT_ABI = [
      { name: "depositBond", type: "function", inputs: [{ name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
    ] as const;
    
    const depositTx = await deployer.writeContract({
      address: proxyAddress,
      abi: DEPOSIT_ABI,
      functionName: "depositBond",
      args: [INITIAL_BOND_DEPOSIT],
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log("   ✓ Deposited", INITIAL_BOND_DEPOSIT.toString(), "wei");

    const newBalance = await publicClient.readContract({
      address: proxyAddress,
      abi: VERIFY_ABI,
      functionName: "bondBalance",
    });
    console.log("   New bond balance:", newBalance.toString(), "wei");
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("Deployment Complete!");
  console.log("=".repeat(70));
  console.log("");
  console.log("OOv3Evaluator (Upgradeable):");
  console.log("  Proxy:", proxyAddress);
  console.log("  Implementation:", implAddress);
  console.log("");
  console.log("Update your config files:");
  console.log(`  OOV3_EVALUATOR_ADDRESS=${proxyAddress}`);
  console.log("");
  console.log("Usage:");
  console.log("  When creating ACP jobs, set both:");
  console.log(`    evaluator: ${proxyAddress}`);
  console.log(`    hook: ${proxyAddress}`);
  console.log("");
  console.log("Upgrade:");
  console.log("  The proxy address will remain stable across upgrades.");
  console.log("  To upgrade: call upgradeToAndCall(newImpl, data) from owner.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
