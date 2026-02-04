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
  "0x8004A41392bdd4A4F12339447ab4B8719D562e51" as const;

/** Salt for Escrow proxy (CREATE2; must match deploy-vanity.ts) */
const ESCROW_PROXY_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000018fdc" as Hex;

/** Salt for Escrow implementation (CREATE2; must match deploy-vanity.ts) */
const ESCROW_IMPL_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000008" as Hex;

/**
 * Expected Escrow proxy address (CREATE2 result for ESCROW_PROXY_SALT).
 * Set after running find-salts once; leave empty to use computed address.
 */
/** Set after find-salts once; leave empty to use computed address. */
const EXPECTED_ESCROW_PROXY_ADDRESS: string = "0x8004E0cA46642eC983e5ec537687CB36F9E46351"; // e.g. "0x8004E..."

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

  console.log("Escrow Job (deploy + upgrade, skip if done)");
  console.log("=".repeat(60));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  if (EXPECTED_ESCROW_PROXY_ADDRESS) {
    console.log("Expected Escrow proxy:", EXPECTED_ESCROW_PROXY_ADDRESS);
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
  const escrowProxyInitData = encodeFunctionData({
    abi: minimalUUPSArtifact.abi,
    functionName: "initialize",
    args: [identityProxyAddress],
  });
  const escrowProxyBytecode = await getProxyBytecode(
    minimalUUPSAddress,
    escrowProxyInitData
  );
  const escrowProxyAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: ESCROW_PROXY_SALT,
    bytecodeHash: keccak256(escrowProxyBytecode),
  });

  if (EXPECTED_ESCROW_PROXY_ADDRESS && escrowProxyAddress.toLowerCase() !== EXPECTED_ESCROW_PROXY_ADDRESS.toLowerCase()) {
    throw new Error(
      `Escrow proxy address mismatch: computed ${escrowProxyAddress}, expected ${EXPECTED_ESCROW_PROXY_ADDRESS}. Update ESCROW_PROXY_SALT or EXPECTED_ESCROW_PROXY_ADDRESS.`
    );
  }

  const escrowImplArtifact = await hre.artifacts.readArtifact("EscrowUpgradeable");
  const escrowImplBytecode = escrowImplArtifact.bytecode as Hex;
  const escrowImplAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: ESCROW_IMPL_SALT,
    bytecodeHash: keccak256(escrowImplBytecode),
  });

  // ---------------------------------------------------------------------------
  // Step 1: Deploy Escrow proxy (skip if already deployed)
  // ---------------------------------------------------------------------------

  if (!(await codeAt(escrowProxyAddress)) || (await codeAt(escrowProxyAddress)) === "0x") {
    console.log("1. Deploying Escrow proxy...");
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (ESCROW_PROXY_SALT + escrowProxyBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", escrowProxyAddress);
  } else {
    console.log("1. Escrow proxy already deployed (skip)");
  }

  // ---------------------------------------------------------------------------
  // Step 2: Deploy Escrow implementation (skip if already deployed)
  // ---------------------------------------------------------------------------

  if (!(await codeAt(escrowImplAddress)) || (await codeAt(escrowImplAddress)) === "0x") {
    console.log("2. Deploying Escrow implementation...");
    const deployData = (ESCROW_IMPL_SALT + escrowImplBytecode.slice(2)) as Hex;
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: deployData,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed at:", escrowImplAddress);
  } else {
    console.log("2. Escrow implementation already deployed (skip)");
  }

  // ---------------------------------------------------------------------------
  // Step 3: Upgrade Escrow proxy to EscrowUpgradeable (skip if already upgraded)
  // ---------------------------------------------------------------------------

  const implSlot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const currentImpl = await publicClient.getStorageAt({
    address: escrowProxyAddress,
    slot: implSlot as `0x${string}`,
  });
  const currentImplAddress = currentImpl ? `0x${currentImpl.slice(-40)}` : null;
  const isUpgraded =
    currentImplAddress?.toLowerCase() === escrowImplAddress.toLowerCase();

  if (isUpgraded) {
    console.log("3. Escrow proxy already upgraded (skip)");
  } else {
    const ownerPrivateKey = process.env.OWNER_PRIVATE_KEY;
    if (!ownerPrivateKey) {
      console.log("3. Upgrade skipped: set OWNER_PRIVATE_KEY in .env to upgrade Escrow proxy.");
    } else {
      const pk = ownerPrivateKey.startsWith("0x") ? ownerPrivateKey : `0x${ownerPrivateKey}`;
      const { createWalletClient, http } = await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const ownerAccount = privateKeyToAccount(pk as `0x${string}`);
      const ownerWallet = createWalletClient({
        account: ownerAccount,
        chain: (await viem.getPublicClient()).chain,
        transport: http(),
      });
      console.log("3. Upgrading Escrow proxy to EscrowUpgradeable...");
      const escrowInitData = encodeFunctionData({
        abi: escrowImplArtifact.abi,
        functionName: "initialize",
        args: [identityProxyAddress],
      });
      const upgradeData = encodeFunctionData({
        abi: minimalUUPSArtifact.abi,
        functionName: "upgradeToAndCall",
        args: [escrowImplAddress, escrowInitData],
      });
      const txHash = await ownerWallet.sendTransaction({
        to: escrowProxyAddress,
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
    console.log("4. Verifying Escrow implementation on block explorer...");
    try {
      const verified = await verifyContract(
        {
          address: escrowImplAddress,
          contract: "contracts/EscrowUpgradeable.sol:EscrowUpgradeable",
          constructorArgs: [],
          provider: "etherscan",
        },
        hre,
      );
      if (verified) {
        console.log("   Escrow implementation verified.");
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
  console.log("Escrow proxy:  ", escrowProxyAddress);
  console.log("Escrow impl:   ", escrowImplAddress);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
