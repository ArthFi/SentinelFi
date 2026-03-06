import type { VercelRequest, VercelResponse } from "@vercel/node"
import type { IncomingMessage } from "http"

/**
 * gemini-proxy.ts — Smart Gemini API mock for CRE simulation
 *
 * Supports two modes:
 *
 * 1. COMBINED MODE (preferred — saves HTTP calls for CRE's 5-call limit):
 *    The prompt contains "REPORT_URL: <url>". The proxy fetches the report
 *    server-side, extracts BOTH DSCR and leverage, and returns them together.
 *    Response text: {"dscr": 2.1, "leverage": 4.2}
 *
 * 2. SINGLE MODE (legacy — prompt contains embedded report text):
 *    Detects whether DSCR or leverage is requested, extracts the value
 *    from the embedded report text via regex.
 *    Response text: {"value": 2.1}
 *
 * Both modes return Gemini-format JSON so the CRE workflow parses identically.
 *
 * bodyParser is DISABLED — CRE SDK may send base64-encoded body.
 */

export const config = {
  api: { bodyParser: false },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

const DSCR_PATTERNS = [
  /DSCR\)[\s:]+(?:is\s+)?(?:now\s+)?([\d.]+)x/i,
  /Debt Service Coverage Ratio[^:]*?:\s*([\d.]+)x/i,
  /DSCR[^:]*?:\s*([\d.]+)x/i,
  /coverage ratio[^:]*?([\d.]+)x/i,
]

const LEVERAGE_PATTERNS = [
  /leverage ratio[^:]*?(?:of\s+|is\s+)?(?:now\s+)?([\d.]+)x/i,
  /leverage[^:]*?:\s*([\d.]+)x/i,
  /(?:Total Debt\s*\/\s*EBITDA)[^:]*?([\d.]+)x/i,
]

function extractValue(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const val = parseFloat(match[1])
      if (!isNaN(val)) return val
    }
  }
  return null
}

function geminiWrap(textContent: string): object {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: textContent }],
          role: "model",
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 10,
      totalTokenCount: 110,
    },
  }
}

function geminiError(message: string, status: number): object {
  return {
    error: { code: status, message, status: "INVALID_ARGUMENT" },
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, x-goog-api-key"
  )
  res.setHeader("Cache-Control", "no-store")

  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "POST")
    return res.status(405).json(geminiError("Method not allowed", 405))

  try {
    // --- Read & parse body ---
    const rawBuf = await readRawBody(req)
    const rawStr = rawBuf.toString("utf-8")

    let bodyObj: any = undefined
    try {
      bodyObj = JSON.parse(rawStr)
    } catch {
      try {
        bodyObj = JSON.parse(
          Buffer.from(rawStr, "base64").toString("utf-8")
        )
      } catch {
        /* not parseable */
      }
    }

    const promptText: string =
      bodyObj?.contents?.[0]?.parts?.[0]?.text ?? ""

    if (!promptText) {
      return res.status(400).json(
        geminiError("No prompt text found in request body", 400)
      )
    }

    // ---------------------------------------------------------------
    // COMBINED MODE: prompt starts with "REPORT_URL: <url>"
    // ---------------------------------------------------------------
    const urlMatch = promptText.match(/^REPORT_URL:\s*(https?:\/\/\S+)/i)
    if (urlMatch) {
      const reportUrl = urlMatch[1]

      // Fetch the report server-side
      const reportRes = await fetch(reportUrl)
      const reportJson = (await reportRes.json()) as {
        documentBody?: string
      }
      const reportText = reportJson.documentBody ?? ""

      if (!reportText) {
        return res.status(400).json(
          geminiError(`Empty report from ${reportUrl}`, 400)
        )
      }

      // Extract both metrics
      const dscr = extractValue(reportText, DSCR_PATTERNS) ?? 2.1
      const leverage = extractValue(reportText, LEVERAGE_PATTERNS) ?? 4.2

      return res
        .status(200)
        .json(geminiWrap(JSON.stringify({ dscr, leverage })))
    }

    // ---------------------------------------------------------------
    // SINGLE MODE: prompt embeds report text, asks for one metric
    // ---------------------------------------------------------------
    const instructionPart = promptText
      .split("FINANCIAL REPORT")[0]
      .toLowerCase()
    const isDscr =
      instructionPart.includes("debt service coverage") ||
      instructionPart.includes("dscr")
    const isLeverage =
      instructionPart.includes("leverage ratio") ||
      instructionPart.includes("total debt / ebitda")

    let value: number | null = null
    if (isDscr) value = extractValue(promptText, DSCR_PATTERNS)
    else if (isLeverage) value = extractValue(promptText, LEVERAGE_PATTERNS)

    if (value === null) {
      value = extractValue(promptText, DSCR_PATTERNS)
      if (value === null) value = extractValue(promptText, LEVERAGE_PATTERNS)
    }
    if (value === null) value = isDscr ? 2.1 : 4.2

    return res.status(200).json(geminiWrap(JSON.stringify({ value })))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return res.status(500).json(geminiError(msg, 500))
  }
}
