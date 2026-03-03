import {
  CronCapability,
  HTTPClient,
  EVMClient,
  handler,
  consensusMedianAggregation,
  ok,
  json,
  prepareReportRequest,
  hexToBase64,
  bytesToHex,
  type Runtime,
  type CronPayload,
  type HTTPSendRequester,
} from "@chainlink/cre-sdk"
import { z } from "zod"
import { encodeAbiParameters, parseAbiParameters } from "viem"

const ConfigSchema = z.object({
  contractAddress: z.string().startsWith("0x"),
  loanId: z.string().startsWith("0x"),
  mockApiUrl: z.string().url(),
  geminiApiUrl: z.string().url(),
  targetChain: z.string(),
  gasLimit: z.string().optional().default("500000"),
})
type Config = z.infer<typeof ConfigSchema>

const extractMetric = (
  sendRequester: HTTPSendRequester,
  mockApiUrl: string,
  geminiApiUrl: string,
  geminiApiKey: string,
  metricName: "dscr" | "leverage"
): number => {

  const reportRes = sendRequester.sendRequest({
    url: mockApiUrl,
    method: "GET",
    multiHeaders: { "Accept": { values: ["application/json"] } },
    timeout: "8s",
  }).result()

  if (!ok(reportRes)) {
    throw new Error(`Report fetch failed with status: ${reportRes.statusCode}`)
  }

  const reportData = json(reportRes) as { documentBody: string }
  const documentText = reportData.documentBody

  const metricDescription = metricName === "dscr"
    ? "Debt Service Coverage Ratio (DSCR)"
    : "Leverage Ratio (total debt divided by EBITDA)"

  const systemPrompt =
    "You are a financial data extraction system. " +
    "Extract ONLY the " + metricDescription + " from the provided text as a decimal number. " +
    "Return ONLY this exact JSON with no other text, no markdown, no explanation: " +
    '{"value": <number>}'

  const geminiPayload: Record<string, unknown> = {}
  const payloadUnsorted: Record<string, unknown> = {
    contents: [{ parts: [{ text: documentText }] }],
    generationConfig: {
      maxOutputTokens: 50,
      response_mime_type: "application/json",
      temperature: 0.0,
    },
    system_instruction: { parts: [{ text: systemPrompt }] },
  }

  Object.keys(payloadUnsorted).sort().forEach((key) => {
    geminiPayload[key] = payloadUnsorted[key]
  })

  const payloadStr = JSON.stringify(geminiPayload)
  const payloadBytes = new TextEncoder().encode(payloadStr)
  let binaryStr = ""
  for (let i = 0; i < payloadBytes.length; i++) {
    binaryStr += String.fromCharCode(payloadBytes[i])
  }
  const base64Body = btoa(binaryStr)

  const geminiRes = sendRequester.sendRequest({
    url: geminiApiUrl + "?key=" + geminiApiKey,
    method: "POST",
    multiHeaders: { "Content-Type": { values: ["application/json"] } },
    body: base64Body,
    timeout: "15s",
  }).result()

  if (!ok(geminiRes)) {
    throw new Error("Gemini API error: " + geminiRes.statusCode)
  }

  const geminiData = json(geminiRes) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }

  const extractedText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""

  if (!extractedText) {
    throw new Error("Empty response from Gemini for metric: " + metricName)
  }

  const cleaned = extractedText
    .replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
    .trim()

  const parsed = JSON.parse(cleaned) as { value: number }

  if (typeof parsed.value !== "number" || isNaN(parsed.value) || parsed.value < 0) {
    throw new Error("Invalid metric value from LLM: " + cleaned)
  }

  return parsed.value
}

const onQuarterlyCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log("=== Covenant Monitor Triggered ===")

  const config = ConfigSchema.parse(runtime.config)
  const geminiSecret = runtime.getSecret({ id: "GEMINI_API_KEY" }).result()
  const geminiApiKey = geminiSecret.value

  runtime.log("Monitoring loan: " + config.loanId)
  runtime.log("Target contract: " + config.contractAddress)

  const httpClient = new HTTPClient()

  const chainKey = config.targetChain as keyof typeof EVMClient.SUPPORTED_CHAIN_SELECTORS
  const chainSelector = EVMClient.SUPPORTED_CHAIN_SELECTORS[chainKey]
  if (!chainSelector) {
    throw new Error("Unsupported chain: " + config.targetChain + ". Valid: " + Object.keys(EVMClient.SUPPORTED_CHAIN_SELECTORS).join(", "))
  }
  const evmClient = new EVMClient(chainSelector)

  const dscr = httpClient.sendRequest(
    runtime,
    (sr: HTTPSendRequester) => extractMetric(
      sr, config.mockApiUrl, config.geminiApiUrl, geminiApiKey, "dscr"
    ),
    consensusMedianAggregation<number>()
  )().result()

  runtime.log("DSCR consensus: " + dscr)

  const leverage = httpClient.sendRequest(
    runtime,
    (sr: HTTPSendRequester) => extractMetric(
      sr, config.mockApiUrl, config.geminiApiUrl, geminiApiKey, "leverage"
    ),
    consensusMedianAggregation<number>()
  )().result()

  runtime.log("Leverage consensus: " + leverage)

  const SCALE = 10000
  const dscrScaled = BigInt(Math.round(dscr * SCALE))
  const leverageScaled = BigInt(Math.round(leverage * SCALE))

  runtime.log("Scaled values - DSCR: " + dscrScaled + ", Leverage: " + leverageScaled)
  runtime.log("Report ready for on-chain covenant evaluation")

  const encodedReport = encodeAbiParameters(
    parseAbiParameters("bytes32 loanId, uint256 currentLeverage, uint256 currentDscr"),
    [config.loanId as `0x${string}`, leverageScaled, dscrScaled]
  )

  let report: any
  try {
    report = runtime.report(prepareReportRequest(encodedReport)).result()
  } catch (e) {
    runtime.log("Report signing failed: " + String(e))
    throw e
  }

  let tx: any
  try {
    tx = evmClient.writeReport(runtime, {
      receiver: hexToBase64(config.contractAddress as `0x${string}`),
      report: report,
      gasConfig: { gasLimit: config.gasLimit },
    }).result()
  } catch (e) {
    runtime.log("On-chain write failed: " + String(e))
    throw e
  }

  const txHashHex = tx.txHash
    ? bytesToHex(tx.txHash)
    : "0x0000000000000000000000000000000000000000000000000000000000000000"

  runtime.log("Transaction hash: " + txHashHex)
  runtime.log("View on Etherscan: https://sepolia.etherscan.io/tx/" + txHashHex)

  return JSON.stringify({
    loanId: config.loanId,
    dscr,
    leverage,
    dscrScaled: dscrScaled.toString(),
    leverageScaled: leverageScaled.toString(),
    txHash: txHashHex,
  })
}

export const initWorkflow = () => {
  const cron = new CronCapability()
  return [
    handler(cron.trigger({ schedule: "0 0 1 1,4,7,10 *" }), onQuarterlyCron),
  ]
}
