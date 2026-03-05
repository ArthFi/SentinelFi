import {
  CronCapability,
  HTTPClient,
  EVMClient,
  Runner,
  handler,
  consensusMedianAggregation,
  prepareReportRequest,
  getNetwork,
  bytesToHex,
  type Runtime,
  type NodeRuntime,
} from "@chainlink/cre-sdk"
import { z } from "zod"
import { encodeAbiParameters, parseAbiParameters } from "viem"

// ---------------------------------------------------------------------------
// Config Schema — validated at runtime by Zod
// ---------------------------------------------------------------------------
const configSchema = z.object({
  contractAddress: z.string().startsWith("0x"),
  loanIds: z.array(z.string().startsWith("0x")).min(1),
  mockApiUrl: z.string().startsWith("https://"),
  geminiApiUrl: z.string().startsWith("https://"),
  targetChain: z.string(),
  gasLimit: z.string().optional(),
  schedule: z.string().optional(),
})
type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// sortedStringify — recursive key-sorted JSON serialization
// Ensures every DON node produces byte-identical payloads for consensus
// ---------------------------------------------------------------------------
function sortedStringify(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(sortedStringify).join(",")}]`
  const sorted: Record<string, unknown> = {}
  Object.keys(obj as Record<string, unknown>)
    .sort()
    .forEach((k) => {
      sorted[k] = (obj as Record<string, unknown>)[k]
    })
  return `{${Object.keys(sorted)
    .map((k) => `"${k}":${sortedStringify(sorted[k])}`)
    .join(",")}}`
}

// ---------------------------------------------------------------------------
// toBase64 — pure-JS base64 encoding (no btoa or Buffer in WASM/Javy)
// ---------------------------------------------------------------------------
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let result = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    result += chars[b0 >> 2]
    result += chars[((b0 & 3) << 4) | (b1 >> 4)]
    result += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "="
    result += i + 2 < bytes.length ? chars[b2 & 63] : "="
  }
  return result
}

// ---------------------------------------------------------------------------
// extractMetric — runs inside runInNodeMode (each DON node independently)
//
// Fetches the financial report, sends to Gemini API for metric extraction,
// returns the parsed number. Each DON node runs this and then consensus
// aggregates the results.
// ---------------------------------------------------------------------------
const SCALE = 10000

function extractMetric(
  nodeRuntime: NodeRuntime<Config>,
  geminiApiKey: string,
  metricName: "dscr" | "leverage"
): number {
  const httpClient = new HTTPClient()

  // 1. Fetch the financial report
  const reportRes = httpClient
    .sendRequest(nodeRuntime, {
      url: nodeRuntime.config.mockApiUrl,
      method: "GET",
    })
    .result()

  const reportRaw = new TextDecoder().decode(reportRes.body)
  let reportJson: Record<string, unknown>
  try {
    reportJson = JSON.parse(reportRaw)
  } catch {
    throw new Error(`REPORT_PARSE_FAIL: len=${reportRaw.length}`)
  }
  const reportText = String(reportJson.documentBody ?? "")

  // 2. Build Gemini prompt
  const metricDescription =
    metricName === "dscr"
      ? "Debt Service Coverage Ratio (DSCR)"
      : "leverage ratio (Total Debt / EBITDA)"

  const promptText = `You are a financial analyst. Extract the ${metricDescription} from the following financial report.
Return ONLY a JSON object: {"value": <number>}

FINANCIAL REPORT:
${reportText}`

  // 3. Build deterministic Gemini payload
  const rawPayload: Record<string, unknown> = {
    contents: [{ parts: [{ text: promptText }], role: "user" }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0,
    },
  }
  const bodyStr = sortedStringify(rawPayload)
  const base64Body = toBase64(bodyStr)

  // 4. Call Gemini API
  const geminiRes = httpClient
    .sendRequest(nodeRuntime, {
      url: `${nodeRuntime.config.geminiApiUrl}?key=${geminiApiKey}`,
      method: "POST",
      multiHeaders: { "Content-Type": { values: ["application/json"] } },
      body: base64Body,
    })
    .result()

  // 5. Parse response
  const geminiRaw = new TextDecoder().decode(geminiRes.body)
  let geminiJson: Record<string, unknown>
  try {
    geminiJson = JSON.parse(geminiRaw)
  } catch {
    throw new Error(
      `PARSE_GEMINI_FAIL: len=${geminiRaw.length} body=${geminiRaw.substring(0, 300)}`
    )
  }

  let rawText: string =
    (geminiJson as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  rawText = rawText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error(
      `PARSE_VALUE_FAIL: rawText="${rawText}" geminiRaw=${geminiRaw.substring(0, 400)}`
    )
  }

  const value =
    typeof parsed.value === "number"
      ? parsed.value
      : parseFloat(String(parsed.value))

  if (isNaN(value)) {
    throw new Error(`extractMetric(${metricName}): NaN — raw=${parsed.value}`)
  }

  return value
}

// ---------------------------------------------------------------------------
// onQuarterlyCron — main CRE handler (DON-level)
//
// For EACH loan in the portfolio:
//   1. DSCR consensus round
//   2. Leverage consensus round
//   3. ABI-encode, sign report, write on-chain
//
// HTTP budget: 2 calls per metric × 2 metrics × 3 loans = 12 calls
// ---------------------------------------------------------------------------
function onQuarterlyCron(runtime: Runtime<Config>): string {
  const geminiApiKey = runtime
    .getSecret({ id: "GEMINI_API_KEY" })
    .result().value

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.targetChain,
    isTestnet: true,
  })
  if (!network) {
    throw new Error(`Network not found: ${runtime.config.targetChain}`)
  }
  const evmClient = new EVMClient(network.chainSelector.selector)

  const results: Array<{
    loanId: string
    txHash: string
    leverage: string
    dscr: string
  }> = []

  runtime.log(`=== Covenant Monitor Triggered ===`)
  runtime.log(`Portfolio size: ${runtime.config.loanIds.length} loans`)

  for (let i = 0; i < runtime.config.loanIds.length; i++) {
    const loanId = runtime.config.loanIds[i]
    runtime.log(
      `Processing loan ${i + 1}/${runtime.config.loanIds.length}: ${loanId.slice(0, 10)}...`
    )

    // DSCR consensus round
    const dscrValue = runtime
      .runInNodeMode(
        (nodeRuntime: NodeRuntime<Config>): number => {
          return extractMetric(nodeRuntime, geminiApiKey, "dscr")
        },
        consensusMedianAggregation<number>()
      )()
      .result()

    // Leverage consensus round
    const leverageValue = runtime
      .runInNodeMode(
        (nodeRuntime: NodeRuntime<Config>): number => {
          return extractMetric(nodeRuntime, geminiApiKey, "leverage")
        },
        consensusMedianAggregation<number>()
      )()
      .result()

    // Scale to integer
    const dscrScaled = BigInt(Math.round(dscrValue * SCALE))
    const leverageScaled = BigInt(Math.round(leverageValue * SCALE))

    runtime.log(
      `Loan ${loanId.slice(0, 10)}... DSCR=${dscrScaled} Leverage=${leverageScaled}`
    )

    // ABI encode — (bytes32 loanId, uint256 leverage, uint256 dscr)
    const loanIdBytes32 = loanId as `0x${string}`
    const callData = encodeAbiParameters(
      parseAbiParameters("bytes32, uint256, uint256"),
      [loanIdBytes32, leverageScaled, dscrScaled]
    )

    // Sign and write — prepareReportRequest wraps callData for on-chain delivery
    const report = runtime.report(prepareReportRequest(callData)).result()
    const writeResult = evmClient
      .writeReport(runtime, {
        receiver: runtime.config.contractAddress as `0x${string}`,
        report,
        gasConfig: { gasLimit: runtime.config.gasLimit ?? "500000" },
      })
      .result()

    const txHash = writeResult.txHash
      ? bytesToHex(writeResult.txHash)
      : "0x0000000000000000000000000000000000000000000000000000000000000000"
    runtime.log(
      `Loan ${loanId.slice(0, 10)}...: tx=${txHash}, leverage=${leverageScaled}, dscr=${dscrScaled}`
    )
    results.push({
      loanId,
      txHash,
      leverage: leverageScaled.toString(),
      dscr: dscrScaled.toString(),
    })
  }

  runtime.log(`=== All ${results.length} loans processed ===`)
  return JSON.stringify(results)
}

// ---------------------------------------------------------------------------
// Workflow initialization — CRE entry point
// ---------------------------------------------------------------------------
const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [
    handler(
      cron.trigger({ schedule: config.schedule ?? "0 0 1 1,4,7,10 *" }),
      onQuarterlyCron
    ),
  ]
}

// ---------------------------------------------------------------------------
// WASM main() entry point — required by CRE runtime
// ---------------------------------------------------------------------------
export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
main()
