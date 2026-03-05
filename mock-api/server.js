const express = require("express");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
const PORT = 3456;

const ANVIL_RPC = "http://127.0.0.1:8545";
const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const FORWARDER_KEY = process.env.FORWARDER_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SCALE = 10000;

// Full loan ID hashes (keccak256)
const ACME_ID = "0x312cfb52614a2cbf2f8ece234ea157b45b86a72cd194895d80c3508ace33e5a2";
const BETA_ID = "0x150b4c129e04fc1a113ccc8bf92b0bbcb57aba8b5ca620530aa7125b95c0af15";
const GAMMA_ID = "0x9e2dadcc004dc693e8c1ea57896e12a099f72bf608cbd90248de618eb523cf0a";

const LOAN_NAMES = {
  [ACME_ID]: "ACME-001",
  [BETA_ID]: "BETA-002",
  [GAMMA_ID]: "GAMMA-003",
};

const CONTRACT_ABI = [
  "function onReport(bytes metadata, bytes report) external",
  "function getLoanHealth(bytes32 loanId) view returns (tuple(uint256 maxLeverageScaled, uint256 minDscrScaled, uint256 lastLeverage, uint256 lastDscr, uint256 lastUpdated, bool isFrozen))",
  "function getLoanIds() view returns (bytes32[])",
  "function getAllLoans() view returns (bytes32[] ids, tuple(uint256 maxLeverageScaled, uint256 minDscrScaled, uint256 lastLeverage, uint256 lastDscr, uint256 lastUpdated, bool isFrozen)[] terms)"
];

const REPORTS = {
  healthy: [
    "ACME CORPORATION - QUARTERLY FINANCIAL REPORT Q4 2025",
    "Prepared for: Covenant Monitoring System | Classification: Confidential",
    "",
    "DEBT SERVICE COVERAGE:",
    "Net Operating Income for the trailing twelve months: $2,100,000.",
    "Total annual debt service obligations: $1,000,000.",
    "The resulting Debt Service Coverage Ratio (DSCR) is 2.10x,",
    "which comfortably exceeds the covenant minimum of 1.25x.",
    "",
    "LEVERAGE ANALYSIS:",
    "Total senior secured debt outstanding: $21,000,000.",
    "Trailing twelve month EBITDA: $5,000,000.",
    "This produces a leverage ratio of 4.20x, well below the covenant",
    "maximum of 6.00x. The borrower remains in full compliance with all",
    "financial maintenance covenants. No remediation action required.",
  ].join("\n"),

  borderline: [
    "ACME CORPORATION - QUARTERLY FINANCIAL REPORT Q4 2025",
    "Prepared for: Covenant Monitoring System | Classification: Confidential",
    "",
    "DEBT SERVICE COVERAGE:",
    "Net Operating Income for the trailing twelve months: $1,300,000.",
    "Total annual debt service obligations: $1,000,000.",
    "Current leverage ratio: 5.90x. Debt Service Coverage Ratio (DSCR): 1.30x.",
    "Both metrics are approaching covenant limits. Management is monitoring.",
    "",
    "LEVERAGE ANALYSIS:",
    "Total debt: $29,500,000 against trailing EBITDA of $5,000,000.",
    "The leverage ratio of 5.90x is near the covenant maximum of 6.00x.",
    "The company is operating near covenant limits on both measures.",
    "Lender notification sent. Remediation plan under preparation.",
  ].join("\n"),

  breached: [
    "ACME CORPORATION - QUARTERLY FINANCIAL REPORT Q4 2025",
    "Prepared for: Covenant Monitoring System | Classification: URGENT",
    "",
    "DEBT SERVICE COVERAGE - COVENANT BREACH:",
    "Net Operating Income declined to $950,000 due to revenue compression.",
    "Total annual debt service obligations remain $1,000,000.",
    "The Debt Service Coverage Ratio (DSCR) is now 0.95x - BELOW the",
    "covenant minimum of 1.25x. The borrower cannot service its debt",
    "from operating cash flow. This constitutes a covenant breach.",
    "",
    "LEVERAGE ANALYSIS - COVENANT BREACH:",
    "Total debt increased to $36,000,000 following delayed payment obligations.",
    "Trailing EBITDA declined to $5,000,000. The leverage ratio is now 7.20x,",
    "exceeding the covenant maximum of 6.00x by 120 basis points.",
    "BOTH covenants are in breach. Immediate lender action required.",
    "Facility should be frozen pending remediation or default declaration.",
  ].join("\n"),
};

app.use(express.json());

const rateLimitMap = new Map();
const RATE_LIMIT_MS = 2000;
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const last = rateLimitMap.get(ip) || 0;
  if (now - last < RATE_LIMIT_MS) {
    return res.status(429).json({ success: false, error: "Rate limited - wait 2s between requests" });
  }
  rateLimitMap.set(ip, now);
  next();
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use("/frontend", express.static(path.join(__dirname, "..", "frontend")));

app.get("/", (req, res) => {
  res.redirect("/frontend/index.html");
});

app.get("/api/report", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const status = req.query.status || "healthy";
  const documentBody = REPORTS[status] || REPORTS.healthy;
  res.json({
    borrowerId: "LOAN-ACME-001",
    period: "Q4-2025",
    reportDate: new Date().toISOString().split("T")[0],
    documentBody,
  });
});

async function sendReport(loanId, leverage, dscr) {
  const provider = new ethers.JsonRpcProvider(ANVIL_RPC);
  const signer = new ethers.Wallet(FORWARDER_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

  const leverageScaled = Math.round(leverage * SCALE);
  const dscrScaled = Math.round(dscr * SCALE);

  const reportPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "uint256"],
    [loanId, leverageScaled, dscrScaled]
  );

  const tx = await contract.onReport("0x", reportPayload);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

app.post("/api/simulate", rateLimit, async (req, res) => {
  try {
    const { loanId, leverage, dscr } = req.body;
    if (!loanId || leverage == null || dscr == null) {
      return res.status(400).json({ success: false, error: "Missing loanId, leverage, or dscr" });
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(loanId)) {
      return res.status(400).json({ success: false, error: "Invalid loanId format (expected bytes32 hex)" });
    }
    const result = await sendReport(loanId, leverage, dscr);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error("Simulate error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/auto-demo", rateLimit, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });

  let clientDisconnected = false;
  req.on("close", () => { clientDisconnected = true; });

  // Multi-loan demo: demonstrates per-loan threshold isolation
  // Step 2 uses BETA-002 to show that identical values produce different outcomes
  const steps = [
    { loanId: ACME_ID, leverage: 4.20, dscr: 2.10, label: "Step 1: Portfolio Healthy", stage: "healthy", description: "ACME-001 — all covenants met" },
    { loanId: BETA_ID, leverage: 5.90, dscr: 1.30, label: "Step 2: Threshold Isolation", stage: "borderline", description: "Same values → ACME passes (max 6.0x), BETA breaches (max 5.0x)" },
    { loanId: ACME_ID, leverage: 7.20, dscr: 0.95, label: "Step 3: Covenant Breach", stage: "breach", description: "ACME-001 — both metrics violated, loan frozen" },
    { loanId: ACME_ID, leverage: 4.00, dscr: 2.00, label: "Step 4: Recovery", stage: "recovery", description: "ACME-001 — metrics restored, loan unfrozen" },
  ];

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  for (let i = 0; i < steps.length; i++) {
    if (clientDisconnected) break;
    const step = steps[i];
    sendSSE({
      type: "step-start", step: i, label: step.label, total: steps.length,
      stage: step.stage, leverage: step.leverage, dscr: step.dscr,
      loanId: step.loanId, loanName: LOAN_NAMES[step.loanId] || step.loanId.slice(0, 10),
      description: step.description,
    });

    for (let s = 0; s < 6; s++) {
      sendSSE({ type: "pipeline", step: i, pipelineStage: s });
      await new Promise((r) => setTimeout(r, 400));
    }

    try {
      const result = await sendReport(step.loanId, step.leverage, step.dscr);
      sendSSE({ type: "step-done", step: i, label: step.label, ...result, stage: step.stage, loanId: step.loanId, loanName: LOAN_NAMES[step.loanId] });
    } catch (e) {
      sendSSE({ type: "step-error", step: i, label: step.label, error: e.message });
    }

    if (i < steps.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  sendSSE({ type: "demo-complete" });
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n  SentinelFi Mock API`);
  console.log(`  Dashboard:   http://localhost:${PORT}/`);
  console.log(`  Report API:  http://localhost:${PORT}/api/report?status=healthy`);
  console.log(`  Simulate:    POST http://localhost:${PORT}/api/simulate`);
  console.log(`  Auto-Demo:   GET  http://localhost:${PORT}/api/auto-demo\n`);
});
