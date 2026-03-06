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
// extractCombinedMetrics — runs inside runInNodeMode (each DON node)
//
// Makes a SINGLE HTTP call to the Gemini proxy in "combined" mode.
// The proxy fetches the financial report server-side and returns both
// DSCR and leverage in one response, staying within CRE's 5-call limit.
//
// Returns an encoded number: Math.round(dscr * SCALE) * 1000000 + Math.round(leverage * SCALE)
// This allows a single consensus round per loan instead of two.
// ---------------------------------------------------------------------------
const SCALE = 10000
const ENCODE_FACTOR = 1000000

function extractCombinedMetrics(
  nodeRuntime: NodeRuntime<Config>,
  geminiApiKey: string
): number {
  const httpClient = new HTTPClient()

  // Build prompt that tells the proxy to fetch the report itself
  const promptText = `REPORT_URL: ${nodeRuntime.config.mockApiUrl}

Extract both the Debt Service Coverage Ratio (DSCR) and the leverage ratio from the financial report at the URL above.
Return a JSON object: {"dscr": <number>, "leverage": <number>}`

  const rawPayload: Record<string, unknown> = {
    contents: [{ parts: [{ text: promptText }], role: "user" }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0,
    },
  }
  const bodyStr = sortedStringify(rawPayload)
  const base64Body = toBase64(bodyStr)

  // Single HTTP call — proxy fetches report + extracts both metrics
  const geminiRes = httpClient
    .sendRequest(nodeRuntime, {
      url: `${nodeRuntime.config.geminiApiUrl}?key=${geminiApiKey}`,
      method: "POST",
      multiHeaders: { "Content-Type": { values: ["application/json"] } },
      body: base64Body,
    })
    .result()

  // Parse Gemini-format response
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

  const dscr =
    typeof parsed.dscr === "number"
      ? parsed.dscr
      : parseFloat(String(parsed.dscr))
  const leverage =
    typeof parsed.leverage === "number"
      ? parsed.leverage
      : parseFloat(String(parsed.leverage))

  if (isNaN(dscr) || isNaN(leverage)) {
    throw new Error(
      `extractCombinedMetrics: NaN — dscr=${parsed.dscr}, leverage=${parsed.leverage}`
    )
  }

  // Encode both values into a single number for consensus
  // dscr_scaled occupies upper digits, leverage_scaled occupies lower 6 digits
  return Math.round(dscr * SCALE) * ENCODE_FACTOR + Math.round(leverage * SCALE)
}

// ---------------------------------------------------------------------------
// onQuarterlyCron — main CRE handler (DON-level)
//
// For EACH loan in the portfolio:
//   1. Single consensus round: proxy fetches report + extracts both metrics
//   2. Decode combined value into DSCR and leverage
//   3. ABI-encode, sign report, write on-chain
//
// HTTP budget: 1 call per loan × 3 loans = 3 calls (within 5-call limit)
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

    // Single consensus round — proxy fetches report + returns both metrics
    const combined = runtime
      .runInNodeMode(
        (nodeRuntime: NodeRuntime<Config>): number => {
          return extractCombinedMetrics(nodeRuntime, geminiApiKey)
        },
        consensusMedianAggregation<number>()
      )()
      .result()

    // Decode combined value
    const dscrScaled = BigInt(Math.round(combined / ENCODE_FACTOR))
    const leverageScaled = BigInt(Math.round(combined % ENCODE_FACTOR))

    runtime.log(
      `Loan ${loanId.slice(0, 10)}... DSCR=${dscrScaled} Leverage=${leverageScaled} (combined=${combined})`
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
