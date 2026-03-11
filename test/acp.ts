import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, toHex, parseEther, zeroAddress } from "viem";

describe("AgenticCommerceUpgradeable (EIP-8183)", async function () {
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

  // Helper: Deploy mock ERC20 token
  async function deployMockToken() {
    const token = await viem.deployContract("MockERC20", ["Test Token", "TEST", 18]);
    return token;
  }

  // Helper: Mint tokens to address
  async function mintTokens(token: any, to: `0x${string}`, amount: bigint) {
    await token.write.mint([to, amount]);
  }

  // Helper: Deploy ACP proxy directly with ERC1967Proxy
  async function deployACPProxy(tokenAddress: `0x${string}`) {
    // Deploy implementation
    const impl = await viem.deployContract("AgenticCommerceUpgradeable");

    // Encode initialize for AgenticCommerceUpgradeable (pure EIP-8183)
    const initData = encodeACPInitialize(
      tokenAddress,
      BigInt(1000000) // min budget
    );

    // Deploy proxy with initialization
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);

    // Return ACP contract instance
    const acp = await viem.getContractAt("AgenticCommerceUpgradeable", proxy.address);
    return acp;
  }

  // Helper: Encode ACP initialize (pure EIP-8183, no fees)
  function encodeACPInitialize(
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
      const acp = await deployACPProxy(token.address);

      const paymentToken = await acp.read.paymentToken();
      const minBudget = await acp.read.minBudget();
      const nextJobId = await acp.read.nextJobId();

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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
      const description = "Test job description";

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        description,
        zeroAddress, // no hook
      ]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.client), clientAddress);
      assert.equal(getAddress(job.provider), providerAddress);
      assert.equal(getAddress(job.evaluator), evaluatorAddress);
      assert.equal(job.status, Status.Open);
      assert.equal(job.description, description);
    });

    it("should create a job without provider (set later)", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        zeroAddress, // no provider
        evaluatorAddress,
        expiredAt,
        "Job without provider",
        zeroAddress,
      ]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), zeroAddress);
      assert.equal(job.status, Status.Open);
    });

    it("should revert with zero evaluator", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        acpAsClient.write.createJob([
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) - 100); // past
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        acpAsClient.write.createJob([
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        zeroAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await acpAsClient.write.setProvider([BigInt(1), providerAddress, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), providerAddress);
    });

    it("should revert if not client", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        zeroAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const acpAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        acpAsOther.write.setProvider([BigInt(1), providerAddress, "0x"]),
        /NotClient/
      );
    });

    it("should revert if provider already set", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress, // provider already set
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await assert.rejects(
        acpAsClient.write.setProvider([BigInt(1), otherAddress, "0x"]),
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const budget = BigInt(10000000); // 10 tokens
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should allow provider to set budget", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const acpAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: provider },
      });

      const budget = BigInt(5000000);
      await acpAsProvider.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should revert if not client or provider", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      const acpAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        acpAsOther.write.setBudget([BigInt(1), BigInt(1000000), "0x"]),
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      // Mint tokens to client and approve
      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([acp.address, budget]);

      // Fund the job
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Funded);

      // Check escrow balance
      const contractBalance = await token.read.balanceOf([acp.address]);
      assert.equal(contractBalance, budget);
    });

    it("should revert if budget mismatch (front-running protection)", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([acp.address, budget]);

      // Try to fund with wrong expectedBudget
      await assert.rejects(
        acpAsClient.write.fund([BigInt(1), BigInt(5000000), "0x"]), // wrong budget
        /BudgetMismatch/
      );
    });

    it("should revert if provider not set", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });

      await acpAsClient.write.createJob([
        zeroAddress, // no provider
        evaluatorAddress,
        expiredAt,
        "Job",
        zeroAddress,
      ]);

      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await assert.rejects(
        acpAsClient.write.fund([BigInt(1), budget, "0x"]),
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);
      const deliverable = keccak256(toHex("deliverable-cid"));

      // Create and fund job
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      // Submit as provider
      const acpAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: provider },
      });
      await acpAsProvider.write.submit([BigInt(1), deliverable, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Submitted);
      assert.equal(job.deliverable, deliverable);
    });

    it("should revert if not provider", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: client },
      });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      // Try to submit as client
      await assert.rejects(
        acpAsClient.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]),
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);
      const deliverable = keccak256(toHex("deliverable"));

      // Create, fund, submit
      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      const acpAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: provider } });
      await acpAsProvider.write.submit([BigInt(1), deliverable, "0x"]);

      // Complete as evaluator
      const acpAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: evaluator } });
      const reason = keccak256(toHex("approved"));
      await acpAsEvaluator.write.complete([BigInt(1), reason, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Completed);

      // Check provider received full payment (pure EIP-8183, no platform fee)
      const providerBalance = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalance, budget);
    });

    it("should revert if not evaluator", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      const acpAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: provider } });
      await acpAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      // Try to complete as client
      await assert.rejects(
        acpAsClient.write.complete([BigInt(1), keccak256(toHex("reason")), "0x"]),
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
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const reason = keccak256(toHex("cancelled"));
      await acpAsClient.write.reject([BigInt(1), reason, "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Rejected);
    });

    it("should allow evaluator to reject and refund when Funded", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceBefore, BigInt(0));

      // Reject as evaluator
      const acpAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: evaluator } });
      await acpAsEvaluator.write.reject([BigInt(1), keccak256(toHex("rejected")), "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Rejected);

      // Client should be refunded
      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter, budget);
    });

    it("should allow evaluator to reject and refund when Submitted", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      const acpAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: provider } });
      await acpAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      // Reject as evaluator
      const acpAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: evaluator } });
      await acpAsEvaluator.write.reject([BigInt(1), keccak256(toHex("rejected")), "0x"]);

      const job = await acp.read.getJob([BigInt(1)]);
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
      const acp = await deployACPProxy(token.address);

      // Get current block timestamp
      const block = await publicClient.getBlock();
      const expiredAt = block.timestamp + BigInt(60); // 60 seconds from now
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      // Fast forward time past expiry
      await testClient.increaseTime({ seconds: 120 });
      await testClient.mine({ blocks: 1 });

      // Anyone can call claimRefund
      const acpAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: other } });
      await acpAsOther.write.claimRefund([BigInt(1)]);

      const job = await acp.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Expired);

      const clientBalance = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalance, budget);
    });

    it("should revert if not expired", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(10000000);

      const acpAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, { client: { wallet: client } });
      await acpAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await acpAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([acp.address, budget]);
      await acpAsClient.write.fund([BigInt(1), budget, "0x"]);

      await assert.rejects(
        acpAsClient.write.claimRefund([BigInt(1)]),
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
      const acp = await deployACPProxy(token.address);

      const acpAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: deployer },
      });

      await acpAsDeployer.write.setMinBudget([BigInt(5000000)]);
      const newMinBudget = await acp.read.minBudget();
      assert.equal(newMinBudget, BigInt(5000000));
    });

    it("should revert if non-owner tries to set min budget", async () => {
      const token = await deployMockToken();
      const acp = await deployACPProxy(token.address);

      const acpAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", acp.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        acpAsOther.write.setMinBudget([BigInt(5000000)]),
        /OwnableUnauthorizedAccount/
      );
    });
  });
});
