// /src/app/api/nlu/route.ts
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

const SYSTEM = `You are a Thai+English NLU. Classify a short user message into a normalized command.

Output strict JSON with keys:
- intent: one of ["artifact_gi","relic_hsr","confirm","cancel","unknown"]
- character: optional string
- normalized: normalized Thai command text (e.g. "ดู artifact genshin impact", "ดู relic honkai star rail", "ยืนยัน", "ยกเลิก").`;

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    const apiKey =
      process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ intent: "unknown", character: "", normalized: "" });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `${SYSTEM}\n\nUser: ${text}\nJSON:`;
    const resp = await model.generateContent(prompt);
    const raw = resp.response.text().trim();
    const jsonStr = raw.replace(/^```json\s*|\s*```$/g, "");
    let data: any;
    try { data = JSON.parse(jsonStr); }
    catch { data = { intent: "unknown", character: "", normalized: "" }; }

    const ok = (k: string) =>
      ["artifact_gi","relic_hsr","confirm","cancel","unknown"].includes(k);
    return NextResponse.json({
      intent: ok(data?.intent) ? data.intent : "unknown",
      character: typeof data?.character === "string" ? data.character.trim() : "",
      normalized: typeof data?.normalized === "string" ? data.normalized.trim() : ""
    });
  } catch {
    return NextResponse.json({ intent: "unknown", character: "", normalized: "" });
  }
}
