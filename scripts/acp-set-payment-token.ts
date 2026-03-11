/**
 * Set payment token for ACP contract
 * Usage: NEW_PAYMENT_TOKEN=0x... npx hardhat run scripts/acp-set-payment-token.ts --network bscTestnet
 */
import hre from "hardhat";
import dotenv from "dotenv";

dotenv.config();

const PROXY_ADDRESS =
  (process.env.ACP_ADDRESS || "0x8b121FEf5e1688B976D814003f05d9366F3Fa8A3") as `0x${string}`;

const NEW_PAYMENT_TOKEN =
  (process.env.NEW_PAYMENT_TOKEN || "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565") as `0x${string}`;

const ACP_ABI = [
  {
    name: "owner",
    type: "function",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    name: "paymentToken",
    type: "function",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    name: "setPaymentToken",
    type: "function",
    inputs: [{ name: "newToken", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log("Set ACP Payment Token");
  console.log("=".repeat(60));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("ACP Contract:", PROXY_ADDRESS);
  console.log("New Payment Token:", NEW_PAYMENT_TOKEN);
  console.log("");

  // Check owner
  const owner = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: ACP_ABI,
    functionName: "owner",
  });
  console.log("Contract Owner:", owner);

  if (owner.toLowerCase() !== deployer.account.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.account.address} is not the owner ${owner}`);
  }

  // Check current payment token
  const currentToken = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: ACP_ABI,
    functionName: "paymentToken",
  });
  console.log("Current Payment Token:", currentToken);

  if (currentToken.toLowerCase() === NEW_PAYMENT_TOKEN.toLowerCase()) {
    console.log("\n✓ Payment token is already set to the target address.");
    return;
  }

  // Set new payment token
  console.log("\nSetting new payment token...");
  
  const txHash = await deployer.writeContract({
    address: PROXY_ADDRESS,
    abi: ACP_ABI,
    functionName: "setPaymentToken",
    args: [NEW_PAYMENT_TOKEN],
  });
  console.log("TX:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Status:", receipt.status === "success" ? "✅ Success" : "❌ Failed");

  // Verify
  const newToken = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: ACP_ABI,
    functionName: "paymentToken",
  });
  console.log("\nNew Payment Token:", newToken);
  console.log("Match:", newToken.toLowerCase() === NEW_PAYMENT_TOKEN.toLowerCase() ? "✅" : "❌");

  console.log("");
  console.log("=".repeat(60));
  console.log("Done!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
