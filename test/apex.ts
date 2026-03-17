import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, toHex, parseEther, zeroAddress } from "viem";

describe("AgenticCommerceUpgradeable (ERC-8183 APEX)", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  // Get test accounts
  const [deployer, client, provider, evaluator, treasury, other] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const evaluatorAddress = getAddress(evaluator.account.address);
  const treasuryAddress = getAddress(treasury.account.address);
  const otherAddress = getAddress(other.account.address);

  // Status enum matching contract
  const Status = {
    None: 0,
    Open: 1,
    Funded: 2,
    Submitted: 3,
    Completed: 4,
    Rejected: 5,
    Expired: 6,
  };

  // Helper: Deploy mock BEP20 token
  async function deployMockToken() {
    const token = await viem.deployContract("MockBEP20", ["Test Token", "TEST", 18]);
    return token;
  }

  // Helper: Mint tokens to address
  async function mintTokens(token: any, to: `0x${string}`, amount: bigint) {
    await token.write.mint([to, amount]);
  }

  // Helper: Deploy APEX proxy directly with ERC1967Proxy
  async function deployAPEXProxy(tokenAddress: `0x${string}`) {
    // Deploy implementation
    const impl = await viem.deployContract("AgenticCommerceUpgradeable");

    // Encode initialize for AgenticCommerceUpgradeable (pure ERC-8183)
    const initData = encodeAPEXInitialize(
      tokenAddress,
      BigInt(1000000) // min budget
    );

    // Deploy proxy with initialization
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);

    // Return ERC-8183 contract instance
    const apex = await viem.getContractAt("AgenticCommerceUpgradeable", proxy.address);
    return apex;
  }

  // Helper: Encode APEX initialize (pure ERC-8183, no fees)
  function encodeAPEXInitialize(
    paymentToken: `0x${string}`,
    minBudget: bigint
  ): `0x${string}` {
    // function selector for initialize(address,uint256) = keccak256("initialize(address,uint256)")[0:4]
    const selector = keccak256(toHex("initialize(address,uint256)")).slice(0, 10);
    const params = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [paymentToken, minBudget]
    );
    return (selector + params.slice(2)) as `0x${string}`;
  }

  // ============================================================
  // Deployment Tests
  // ============================================================

  describe("Deployment", async () => {
    it("should initialize with correct parameters", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const paymentToken = await apex.read.paymentToken();
      const minBudget = await apex.read.minBudget();
      const nextJobId = await apex.read.nextJobId();

      assert.equal(getAddress(paymentToken), getAddress(token.address));
      assert.equal(minBudget, BigInt(1000000));
      assert.equal(nextJobId, BigInt(1));
    });
  });

  // ============================================================
  // Job Creation Tests
  // ============================================================

  describe("createJob", async () => {
    it("should create a job with provider and evaluator", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
      const description = "Test job description";

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        description,
        zeroAddress, // no hook
      ]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.client), clientAddress);
      assert.equal(getAddress(job.provider), providerAddress);
      assert.equal(getAddress(job.evaluator), evaluatorAddress);
      assert.equal(job.status, Status.Open);
      assert.equal(job.description, description);
    });

    it("should create a job without provider (set later)", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        zeroAddress, // no provider
        evaluatorAddress,
        expiredAt,
        "Job without provider",
        zeroAddress,
      ]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), zeroAddress);
      assert.equal(job.status, Status.Open);
    });

    it("should revert with zero evaluator", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([
          providerAddress,
          zeroAddress, // invalid evaluator
          expiredAt,
          "Invalid job",
          zeroAddress,
        ]),
        /InvalidEvaluator/
      );
    });

    it("should revert with expired timestamp", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) - 100); // past
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([
          providerAddress,
          evaluatorAddress,
          expiredAt,
          "Expired job",
          zeroAddress,
        ]),
        /InvalidExpiry/
      );
    });
  });

  // ============================================================
  // setProvider Tests
  // ============================================================

  describe("setProvider", async () => {
    it("should set provider for job created without one", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        zeroAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await apexAsClient.write.setProvider([BigInt(1), providerAddress, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), providerAddress);
    });

    it("should revert if not client", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        zeroAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setProvider([BigInt(1), providerAddress, "0x"]),
        /NotClient/
      );
    });

    it("should revert if provider already set", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress, // provider already set
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await assert.rejects(
        apexAsClient.write.setProvider([BigInt(1), otherAddress, "0x"]),
        /ProviderAlreadySet/
      );
    });
  });

  // ============================================================
  // setBudget Tests
  // ============================================================

  describe("setBudget", async () => {
    it("should allow client to set budget", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const budget = BigInt(10000000); // 10 tokens
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should allow provider to set budget", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });

      const budget = BigInt(5000000);
      await apexAsProvider.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should revert if not client or provider", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setBudget([BigInt(1), BigInt(1000000), "0x"]),
        /NotClientOrProvider/
      );
    });
  });

  // ============================================================
  // fund Tests
  // ============================================================

  describe("fund", async () => {
    it("should fund job and transition to Funded status", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      // Mint tokens to client and approve
      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);

      // Fund the job
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Funded);

      // Check escrow balance
      const contractBalance = await token.read.balanceOf([apex.address]);
      assert.equal(contractBalance, budget);
    });

    it("should revert if budget mismatch (front-running protection)", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);

      // Try to fund with wrong expectedBudget
      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), BigInt(5000000), "0x"]), // wrong budget
        /BudgetMismatch/
      );
    });

    it("should revert if provider not set", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        zeroAddress, // no provider
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), budget, "0x"]),
        /ProviderNotSet/
      );
    });
  });

  // ============================================================
  // submit Tests
  // ============================================================

  describe("submit", async () => {
    it("should allow provider to submit work", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);
      const deliverable = keccak256(toHex("deliverable-cid"));

      // Create and fund job
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      // Submit as provider
      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([BigInt(1), deliverable, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Submitted);
      assert.equal(job.deliverable, deliverable);
    });

    it("should revert if not provider", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      // Try to submit as client
      await assert.rejects(
        apexAsClient.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]),
        /NotProvider/
      );
    });
  });

  // ============================================================
  // complete Tests
  // ============================================================

  describe("complete", async () => {
    it("should allow evaluator to complete job and release payment", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);
      const deliverable = keccak256(toHex("deliverable"));

      // Create, fund, submit
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([BigInt(1), deliverable, "0x"]);

      // Complete as evaluator
      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      const reason = keccak256(toHex("approved"));
      await apexAsEvaluator.write.complete([BigInt(1), reason, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Completed);

      // Check provider received full payment (pure ERC-8183, no platform fee)
      const providerBalance = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalance, budget);
    });

    it("should revert if not evaluator", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      // Try to complete as client
      await assert.rejects(
        apexAsClient.write.complete([BigInt(1), keccak256(toHex("reason")), "0x"]),
        /NotEvaluator/
      );
    });
  });

  // ============================================================
  // reject Tests
  // ============================================================

  describe("reject", async () => {
    it("should allow client to reject job when Open", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const reason = keccak256(toHex("cancelled"));
      await apexAsClient.write.reject([BigInt(1), reason, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Rejected);
    });

    it("should allow evaluator to reject and refund when Funded", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceBefore, BigInt(0));

      // Reject as evaluator
      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      await apexAsEvaluator.write.reject([BigInt(1), keccak256(toHex("rejected")), "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Rejected);

      // Client should be refunded
      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter, budget);
    });

    it("should allow evaluator to reject and refund when Submitted", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      // Reject as evaluator
      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      await apexAsEvaluator.write.reject([BigInt(1), keccak256(toHex("rejected")), "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Rejected);

      const clientBalance = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalance, budget);
    });
  });

  // ============================================================
  // claimRefund Tests
  // ============================================================

  describe("claimRefund", async () => {
    it("should refund client after expiry", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      // Get current block timestamp
      const block = await publicClient.getBlock();
      const expiredAt = block.timestamp + BigInt(60); // 60 seconds from now
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      // Fast forward time past expiry
      await testClient.increaseTime({ seconds: 120 });
      await testClient.mine({ blocks: 1 });

      // Anyone can call claimRefund
      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: other } });
      await apexAsOther.write.claimRefund([BigInt(1)]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Expired);

      const clientBalance = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalance, budget);
    });

    it("should revert if not expired", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockBEP20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      await assert.rejects(
        apexAsClient.write.claimRefund([BigInt(1)]),
        /NotExpired/
      );
    });
  });

  // ============================================================
  // Admin Functions Tests
  // ============================================================

  describe("Admin Functions", async () => {
    it("should allow owner to set min budget", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await apexAsDeployer.write.setMinBudget([BigInt(5000000)]);
      const newMinBudget = await apex.read.minBudget();
      assert.equal(newMinBudget, BigInt(5000000));
    });

    it("should revert if non-owner tries to set min budget", async () => {
      const token = await deployMockToken();
      const apex = await deployAPEXProxy(token.address);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setMinBudget([BigInt(5000000)]),
        /OwnableUnauthorizedAccount/
      );
    });
  });
});
