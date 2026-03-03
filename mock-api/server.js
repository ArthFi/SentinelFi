const express = require("express");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
const PORT = 3456;

const ANVIL_RPC = "http://127.0.0.1:8545";
const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const FORWARDER_KEY = process.env.FORWARDER_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SCALE = 10000;

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
    "Net Operating Income for the trailing twelve months: $1,250,000.",
    "Total annual debt service obligations: $1,000,000.",
    "The resulting Debt Service Coverage Ratio (DSCR) is exactly 1.25x,",
    "which is at the covenant minimum threshold. Management is monitoring.",
    "",
    "LEVERAGE ANALYSIS:",
    "Total debt: $30,000,000 against trailing EBITDA of $5,000,000.",
    "This yields a leverage ratio of exactly 6.00x - at the covenant maximum.",
    "The company is operating at covenant limits on both measures.",
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
  const status = req.query.status || "breached";
  const documentBody = REPORTS[status] || REPORTS.breached;
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
  const loanId = req.query.loanId || "0x312cfb52614a2cbf2f8ece234ea157b45b86a72cd194895d80c3508ace33e5a2";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });

  let clientDisconnected = false;
  req.on("close", () => { clientDisconnected = true; });

  const steps = [
    { label: "Healthy Report", stage: "healthy", leverage: 4.2, dscr: 2.1 },
    { label: "Borderline Report", stage: "borderline", leverage: 6.0, dscr: 1.25 },
    { label: "Breach Report", stage: "breach", leverage: 7.2, dscr: 0.95 },
    { label: "Recovery Report", stage: "recovery", leverage: 4.2, dscr: 2.1 },
  ];

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  for (let i = 0; i < steps.length; i++) {
    if (clientDisconnected) break;
    const step = steps[i];
    sendSSE({ type: "step-start", step: i, label: step.label, total: steps.length, stage: step.stage });

    for (let s = 0; s < 6; s++) {
      sendSSE({ type: "pipeline", step: i, pipelineStage: s });
      await new Promise((r) => setTimeout(r, 400));
    }

    try {
      const result = await sendReport(loanId, step.leverage, step.dscr);
      sendSSE({ type: "step-done", step: i, label: step.label, ...result, stage: step.stage });
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
