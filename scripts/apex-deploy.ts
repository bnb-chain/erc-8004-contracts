import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  keccak256,
  getCreate2Address,
} from "viem";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// Constants (set once; find-salts is run separately once to discover vanity)
// =============================================================================

const SAFE_SINGLETON_FACTORY =
  "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;

const MINIMAL_UUPS_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;

/** IdentityRegistry proxy (must match deploy-vanity EXPECTED_ADDRESSES) */
const IDENTITY_REGISTRY_PROXY =
  (process.env.IDENTITY_REGISTRY_ADDRESS || "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;

/** UMA Optimistic Oracle V3 address (BSC Testnet) */
const OOV3_ADDRESS =
  (process.env.OOV3_ADDRESS || "0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709") as `0x${string}`;

/** Payment token address (TUSD on BSC Testnet) */
const PAYMENT_TOKEN_ADDRESS =
  (process.env.PAYMENT_TOKEN_ADDRESS || "0xBA3219b3a40bfbA967A3ca2fC37C1aCDcE81be39") as `0x${string}`;

/** ApexUpgradeable configuration */
const APEX_CONFIG = {
  acceptTimeout: BigInt(process.env.ACCEPT_TIMEOUT || "3600"),      // 1 hour
  submitTimeout: BigInt(process.env.SUBMIT_TIMEOUT || "86400"),     // 24 hours
  oov3Liveness: BigInt(process.env.OOV3_LIVENESS || "3600"),        // 1 hour challenge period
  bondRate: BigInt(process.env.BOND_RATE || "1000"),                // 10% (1000 basis points)
};

/** Salt for Apex proxy (CREATE2; computed for existing Identity Registry) */
const APEX_PROXY_SALT =
  "0x000000000000000000000000000000000000000000000000000000000047cd0f" as Hex;

/** Salt for Apex implementation (CREATE2; must match deploy-vanity.ts) */
const APEX_IMPL_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000008" as Hex;

/** Set after find-salts once; leave empty to use computed address. */
const EXPECTED_APEX_PROXY_ADDRESS: string = "0x8004E49143C0A77f9EA5a112CD4e8f10134BeA3e";

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

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const codeAt = async (address: string) =>
    publicClient.getBytecode({ address: address as `0x${string}` });

  console.log("APEX Protocol (deploy + upgrade, skip if done)");
  console.log("=".repeat(60));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  if (EXPECTED_APEX_PROXY_ADDRESS) {
    console.log("Expected Apex proxy:", EXPECTED_APEX_PROXY_ADDRESS);
  }
  console.log("");

  // ---------------------------------------------------------------------------
  // Prerequisites
  // ---------------------------------------------------------------------------

  if (!(await codeAt(SAFE_SINGLETON_FACTORY)) || (await codeAt(SAFE_SINGLETON_FACTORY)) === "0x") {
    throw new Error(
      `SAFE CREATE2 factory not deployed at ${SAFE_SINGLETON_FACTORY}. Run deploy-vanity first.`
    );
  }

  const minimalUUPSArtifact = await hre.artifacts.readArtifact("MinimalUUPS");
  const minimalUUPSBytecode = minimalUUPSArtifact.bytecode as Hex;
  const minimalUUPSAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: MINIMAL_UUPS_SALT,
    bytecodeHash: keccak256(minimalUUPSBytecode),
  });

  if (!(await codeAt(minimalUUPSAddress)) || (await codeAt(minimalUUPSAddress)) === "0x") {
    throw new Error(
      `MinimalUUPS not deployed at ${minimalUUPSAddress}. Run deploy-vanity first.`
    );
  }

  const identityProxyAddress = IDENTITY_REGISTRY_PROXY as `0x${string}`;
  const apexProxyInitData = encodeFunctionData({
    abi: minimalUUPSArtifact.abi,
    functionName: "initialize",
    args: [identityProxyAddress],
  });
  const apexProxyBytecode = await getProxyBytecode(
    minimalUUPSAddress,
    apexProxyInitData
  );
  const apexProxyAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: APEX_PROXY_SALT,
    bytecodeHash: keccak256(apexProxyBytecode),
  });

  if (EXPECTED_APEX_PROXY_ADDRESS && apexProxyAddress.toLowerCase() !== EXPECTED_APEX_PROXY_ADDRESS.toLowerCase()) {
    throw new Error(
      `Apex proxy address mismatch: computed ${apexProxyAddress}, expected ${EXPECTED_APEX_PROXY_ADDRESS}. Update APEX_PROXY_SALT or EXPECTED_APEX_PROXY_ADDRESS.`
    );
  }

  const apexImplArtifact = await hre.artifacts.readArtifact("ApexUpgradeable");
  const apexImplBytecode = apexImplArtifact.bytecode as Hex;
  const apexImplAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: APEX_IMPL_SALT,
    bytecodeHash: keccak256(apexImplBytecode),
  });

  // ---------------------------------------------------------------------------
  // Step 1: Deploy Apex proxy (skip if already deployed)
  // ---------------------------------------------------------------------------

  if (!(await codeAt(apexProxyAddress)) || (await codeAt(apexProxyAddress)) === "0x") {
    console.log("1. Deploying Apex proxy...");
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (APEX_PROXY_SALT + apexProxyBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", apexProxyAddress);
  } else {
    console.log("1. Apex proxy already deployed (skip)");
  }

  // ---------------------------------------------------------------------------
  // Step 2: Deploy Apex implementation (skip if already deployed)
  // ---------------------------------------------------------------------------

  if (!(await codeAt(apexImplAddress)) || (await codeAt(apexImplAddress)) === "0x") {
    console.log("2. Deploying Apex implementation...");
    const deployData = (APEX_IMPL_SALT + apexImplBytecode.slice(2)) as Hex;
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: deployData,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", apexImplAddress);
  } else {
    console.log("2. Apex implementation already deployed (skip)");
  }

  // ---------------------------------------------------------------------------
  // Step 3: Upgrade Apex proxy to ApexUpgradeable (skip if already upgraded)
  // ---------------------------------------------------------------------------

  const implSlot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const currentImpl = await publicClient.getStorageAt({
    address: apexProxyAddress,
    slot: implSlot as `0x${string}`,
  });
  const currentImplAddress = currentImpl ? `0x${currentImpl.slice(-40)}` : null;
  const isUpgraded =
    currentImplAddress?.toLowerCase() === apexImplAddress.toLowerCase();

  if (isUpgraded) {
    console.log("3. Apex proxy already upgraded (skip)");
  } else {
    const ownerPrivateKey = process.env.OWNER_PRIVATE_KEY;
    if (!ownerPrivateKey) {
      console.log("3. Upgrade skipped: set OWNER_PRIVATE_KEY in .env to upgrade Apex proxy.");
    } else {
      const pk = ownerPrivateKey.startsWith("0x") ? ownerPrivateKey : `0x${ownerPrivateKey}`;
      const { createWalletClient, http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const ownerAccount = privateKeyToAccount(pk as `0x${string}`);
      const rpcUrl = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-2-s3.binance.org:8545";
      const ownerWallet = createWalletClient({
        account: ownerAccount,
        chain: (await viem.getPublicClient()).chain,
        transport: http(rpcUrl),
      });
      console.log("3. Upgrading Apex proxy to ApexUpgradeable...");
      console.log("   Config:");
      console.log("     Identity Registry:", identityProxyAddress);
      console.log("     OOV3:", OOV3_ADDRESS);
      console.log("     Payment Token:", PAYMENT_TOKEN_ADDRESS);
      console.log("     Accept Timeout:", APEX_CONFIG.acceptTimeout.toString(), "s");
      console.log("     Submit Timeout:", APEX_CONFIG.submitTimeout.toString(), "s");
      console.log("     OOV3 Liveness:", APEX_CONFIG.oov3Liveness.toString(), "s");
      console.log("     Bond Rate:", APEX_CONFIG.bondRate.toString(), "bps");

      const apexInitData = encodeFunctionData({
        abi: apexImplArtifact.abi,
        functionName: "initialize",
        args: [
          identityProxyAddress,
          OOV3_ADDRESS,
          PAYMENT_TOKEN_ADDRESS,
          APEX_CONFIG.acceptTimeout,
          APEX_CONFIG.submitTimeout,
          APEX_CONFIG.oov3Liveness,
          APEX_CONFIG.bondRate,
        ],
      });
      const upgradeData = encodeFunctionData({
        abi: minimalUUPSArtifact.abi,
        functionName: "upgradeToAndCall",
        args: [apexImplAddress, apexInitData],
      });
      const txHash = await ownerWallet.sendTransaction({
        to: apexProxyAddress,
        data: upgradeData,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log("   Upgraded. Tx:", txHash);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: Verify on Etherscan / BscScan (skip if local or no API key)
  // ---------------------------------------------------------------------------

  const chainId = await publicClient.getChainId();
  const isLocal =
    Number(chainId) === 31337 ||
    connection.networkName === "localhost" ||
    connection.networkName === "local";
  const hasApiKey = !!(process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY);

  if (isLocal) {
    console.log("4. Verify on Etherscan: skipped (local network)");
  } else if (!hasApiKey) {
    console.log("4. Verify on Etherscan: skipped (set ETHERSCAN_API_KEY or BSCSCAN_API_KEY)");
  } else {
    console.log("4. Verifying Apex implementation on block explorer...");
    try {
      const verified = await verifyContract(
        {
          address: apexImplAddress,
          contract: "contracts/ApexUpgradeable.sol:ApexUpgradeable",
          constructorArgs: [],
          provider: "etherscan",
        },
        hre,
      );
      if (verified) {
        console.log("   Apex implementation verified.");
      } else {
        console.log("   Verification returned false (may already be verified).");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Already Verified") || msg.includes("already verified")) {
        console.log("   Already verified (skip).");
      } else {
        console.log("   Verify failed:", msg);
      }
    }
  }

  console.log("");
  console.log("Apex proxy:  ", apexProxyAddress);
  console.log("Apex impl:   ", apexImplAddress);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
