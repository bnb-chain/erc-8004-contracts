import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, toHex, Hex } from "viem";

/**
 * ERC-8004 Escrow tests (same style as local.ts).
 * Requires localhost with vanity deployment: run `npx hardhat node` then `npm run local`, then `npm run test:escrow`.
 * Uses DEPLOYED_ADDRESSES.identityRegistry; deploys Escrow per test via HardhatMinimalUUPS -> EscrowUpgradeable.
 */
const DEPLOYED_ADDRESSES = {
  identityRegistry: "0x8004A41392bdd4A4F12339447ab4B8719D562e51" as const,
};

describe("ERC8004 Escrow", async function () {
  const { viem } = await network.connect("localhost");
  const publicClient = await viem.getPublicClient();

  async function getAgentIdFromRegistration(txHash: `0x${string}`) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const registeredLog = receipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("Registered(uint256,string,address)"))
    );
    if (!registeredLog || !registeredLog.topics[1]) {
      throw new Error("Registered event not found");
    }
    return BigInt(registeredLog.topics[1]);
  }

  async function getPaymentIdFromLockEvent(txHash: `0x${string}`): Promise<Hex> {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const lockLog = receipt.logs.find(
      (log) => log.topics[0] === keccak256(toHex("PaymentLocked(bytes32,address,uint256,uint256)"))
    );
    if (!lockLog || !lockLog.topics[1]) {
      throw new Error("PaymentLocked event not found");
    }
    return lockLog.topics[1] as Hex;
  }

  async function getIdentityRegistry() {
    return await viem.getContractAt(
      "IdentityRegistryUpgradeable",
      DEPLOYED_ADDRESSES.identityRegistry
    );
  }

  async function deployProxy(implementationAddress: `0x${string}`, initCalldata: `0x${string}`) {
    return await viem.deployContract("ERC1967Proxy", [implementationAddress, initCalldata]);
  }

  function encodeInitializeWithAddress(identityRegistry: `0x${string}`): `0x${string}` {
    const params = encodeAbiParameters([{ type: "address" }], [identityRegistry]);
    return ("0xc4d66de8" + params.slice(2)) as `0x${string}`;
  }

  async function deployEscrowProxy() {
    const minimalImpl = await viem.deployContract("HardhatMinimalUUPS");
    const minimalInitCalldata = encodeInitializeWithAddress(
      "0x0000000000000000000000000000000000000000" as `0x${string}`
    );
    const proxy = await deployProxy(minimalImpl.address, minimalInitCalldata);

    const escrowImpl = await viem.deployContract("EscrowUpgradeable");
    const minimalProxy = await viem.getContractAt("HardhatMinimalUUPS", proxy.address);
    const escrowInitCalldata = encodeInitializeWithAddress(
      DEPLOYED_ADDRESSES.identityRegistry as `0x${string}`
    );
    await minimalProxy.write.upgradeToAndCall([escrowImpl.address, escrowInitCalldata]);

    return await viem.getContractAt("EscrowUpgradeable", proxy.address);
  }

  describe("Deployment", async function () {
    it("Should deploy Escrow and return correct getIdentityRegistry and getMinPayment", async function () {
      const escrow = await deployEscrowProxy();

      const identityRegistry = await escrow.read.getIdentityRegistry();
      assert.equal(
        identityRegistry.toLowerCase(),
        DEPLOYED_ADDRESSES.identityRegistry.toLowerCase()
      );

      const minPayment = await escrow.read.getMinPayment();
      assert.equal(minPayment, 10n * 10n ** 9n); // 10 gwei
    });
  });

  describe("lockPayment", async function () {
    it("Should lock payment when client sends >= minPayment for valid agentId", async function () {
      const identityRegistry = await getIdentityRegistry();
      const escrow = await deployEscrowProxy();
      const [client] = await viem.getWalletClients();

      const regTxHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(regTxHash);

      const amount = 10n * 10n ** 9n; // 10 gwei (min)
      const lockTxHash = await escrow.write.lockPayment([agentId], { value: amount });
      const paymentId = await getPaymentIdFromLockEvent(lockTxHash);

      const payment = await escrow.read.getPayment([paymentId]);
      assert.equal(payment[0].toLowerCase(), client.account.address.toLowerCase());
      assert.equal(payment[1], agentId);
      assert.equal(payment[2], amount);
      assert.equal(payment[3], false);
      assert.ok(payment[4] > 0n);
    });

    it("Should revert when amount below minimum", async function () {
      const identityRegistry = await getIdentityRegistry();
      const escrow = await deployEscrowProxy();

      const regTxHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(regTxHash);

      await assert.rejects(
        escrow.write.lockPayment([agentId], { value: 1n }), // 1 wei < 10 gwei
        /amount below minimum/
      );
    });

    it("Should revert when agent not found", async function () {
      const escrow = await deployEscrowProxy();
      const nonExistentAgentId = 999999n;

      await assert.rejects(
        escrow.write.lockPayment([nonExistentAgentId], {
          value: 10n * 10n ** 9n,
        }),
        /agent not found/
      );
    });
  });

  describe("releasePayment", async function () {
    it("Should release payment to agent owner when client calls releasePayment", async function () {
      const identityRegistry = await getIdentityRegistry();
      const escrow = await deployEscrowProxy();
      const [client] = await viem.getWalletClients();

      const regTxHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(regTxHash);
      const agentOwner = await identityRegistry.read.ownerOf([agentId]);

      const amount = 10n * 10n ** 9n;
      const lockTxHash = await escrow.write.lockPayment([agentId], { value: amount });
      const paymentId = await getPaymentIdFromLockEvent(lockTxHash);

      const balanceBefore = await publicClient.getBalance({ address: agentOwner });
      await escrow.write.releasePayment([paymentId]);
      const balanceAfter = await publicClient.getBalance({ address: agentOwner });
      assert.equal(balanceAfter - balanceBefore, amount);

      const payment = await escrow.read.getPayment([paymentId]);
      assert.equal(payment[3], true); // released
    });

    it("Should revert when called by non-client", async function () {
      const identityRegistry = await getIdentityRegistry();
      const escrow = await deployEscrowProxy();
      const [, , other] = await viem.getWalletClients();

      const regTxHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(regTxHash);
      const lockTxHash = await escrow.write.lockPayment([agentId], {
        value: 10n * 10n ** 9n,
      });
      const paymentId = await getPaymentIdFromLockEvent(lockTxHash);

      await assert.rejects(
        escrow.write.releasePayment([paymentId], { account: other.account }),
        /only client can release payment/
      );
    });

    it("Should revert when payment already released", async function () {
      const identityRegistry = await getIdentityRegistry();
      const escrow = await deployEscrowProxy();

      const regTxHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(regTxHash);
      const lockTxHash = await escrow.write.lockPayment([agentId], {
        value: 10n * 10n ** 9n,
      });
      const paymentId = await getPaymentIdFromLockEvent(lockTxHash);

      await escrow.write.releasePayment([paymentId]);
      await assert.rejects(
        escrow.write.releasePayment([paymentId]),
        /payment already released/
      );
    });
  });

  describe("getPayment / getAgentPayments / getClientPayments / getClientLockedPayments", async function () {
    it("Should return correct data from getPayment and list helpers", async function () {
      const identityRegistry = await getIdentityRegistry();
      const escrow = await deployEscrowProxy();
      const [client] = await viem.getWalletClients();

      const regTxHash = await identityRegistry.write.register(["ipfs://agent"]);
      const agentId = await getAgentIdFromRegistration(regTxHash);
      const amount = 10n * 10n ** 9n;
      const lockTxHash = await escrow.write.lockPayment([agentId], { value: amount });
      const paymentId = await getPaymentIdFromLockEvent(lockTxHash);

      const payment = await escrow.read.getPayment([paymentId]);
      assert.equal(payment[0].toLowerCase(), client.account.address.toLowerCase());
      assert.equal(payment[1], agentId);
      assert.equal(payment[2], amount);
      assert.equal(payment[3], false);

      const agentPayments = await escrow.read.getAgentPayments([agentId]);
      assert.equal(agentPayments.length, 1);
      assert.equal(agentPayments[0], paymentId);

      const clientPayments = await escrow.read.getClientPayments([client.account.address]);
      assert.equal(clientPayments.length, 1);
      assert.equal(clientPayments[0], paymentId);

      const lockedPayments = await escrow.read.getClientLockedPayments([client.account.address]);
      assert.equal(lockedPayments.length, 1);
      assert.equal(lockedPayments[0], paymentId);

      await escrow.write.releasePayment([paymentId]);
      const lockedAfter = await escrow.read.getClientLockedPayments([client.account.address]);
      assert.equal(lockedAfter.length, 0);
    });
  });

  describe("setMinPayment / getMinPayment", async function () {
    it("Should allow owner to setMinPayment and getMinPayment reflects new value", async function () {
      const escrow = await deployEscrowProxy();
      const [owner] = await viem.getWalletClients();

      assert.equal(await escrow.read.getMinPayment(), 10n * 10n ** 9n);

      const newMin = 100n * 10n ** 9n; // 100 gwei
      await escrow.write.setMinPayment([newMin], { account: owner.account });
      assert.equal(await escrow.read.getMinPayment(), newMin);
    });

    it("Should revert setMinPayment when called by non-owner", async function () {
      const escrow = await deployEscrowProxy();
      const [, nonOwner] = await viem.getWalletClients();

      await assert.rejects(
        escrow.write.setMinPayment([100n * 10n ** 9n], { account: nonOwner.account }),
        /OwnableUnauthorizedAccount|caller is not the owner/
      );
    });

    it("Should revert setMinPayment when newMinPayment is zero", async function () {
      const escrow = await deployEscrowProxy();
      const [owner] = await viem.getWalletClients();

      await assert.rejects(
        escrow.write.setMinPayment([0n], { account: owner.account }),
        /min payment must be > 0/
      );
    });
  });
});
