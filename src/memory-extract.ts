/**
 * Memory Extraction Module
 * Uses GPT-4o-mini via OpenAI API to extract memorable facts from conversation exchanges.
 * Mini model handles fact extraction equally well at ~16x lower cost.
 * Returns an array of strings to be stored in the memory system.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const EXTRACTION_PROMPT = `Review this conversation exchange and extract any facts, preferences, goals, decisions, or important context worth remembering long term. Return ONLY a JSON array of strings, each string being one memory worth saving. If nothing is worth saving, return an empty array [].

Examples of what to extract:
- Personal facts: "User runs a company called Acme Corp"
- Preferences: "User prefers concise responses"
- Goals: "User wants to automate their sales pipeline"
- Decisions: "Decided to use Postgres for the database"
- Technical context: "The relay runs on port 3007 on the VPS"
- System changes: "Updated the cron job to run at 3 AM instead of midnight"
- Action taken: "Created daily-sweep.py that runs via system crontab"

Do NOT extract:
- Greetings or pleasantries
- Information that's only relevant in the moment
- Duplicate information that's already well-known`;

export async function extractMemories(userMsg: string, assistantMsg: string): Promise<string[]> {
  if (!OPENAI_API_KEY) {
    console.warn("[memory-extract] OPENAI_API_KEY not set, skipping extraction");
    return [];
  }

  try {
    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: `User said: ${userMsg}\n\nAssistant responded: ${assistantMsg.substring(0, 3000)}` },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      console.error("[memory-extract] GPT-4o-mini API error:", resp.status, await resp.text().catch(() => ""));
      return [];
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return [];

    let jsonStr = content;
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0];
    }

    const memories = JSON.parse(jsonStr);
    if (!Array.isArray(memories)) return [];

    return memories.filter((m: any) => typeof m === "string" && m.length > 5);
  } catch (error: any) {
    console.error("[memory-extract] Error:", error.message);
    return [];
  }
}
