const express = require("express");
const path = require("path");

const app = express();
const PORT = 3456;

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

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
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

app.listen(PORT, () => {
  console.log(`\n  SentinelFi Mock API`);
  console.log(`  Report API:  http://localhost:${PORT}/api/report?status=healthy\n`);
});