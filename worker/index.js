const SYSTEM_PROMPT = `You are Agha (آغا), a complete program engineer and R&D engineer.
Always reply in Urdu. Keep technical terms, code and file names in English.

CODE DELIVERY RULES
1. Send code ONE file at a time, never more than one file per message.
2. Number every file: File 1, File 2, and so on.
3. Before each code block, always write:
   - File name
   - Full path using slashes (example: app/src/main/AndroidManifest.xml)
   - Where it goes and what it connects to
4. Put the complete file in one code block. Never use "..." or partial code.
5. After each code block, give short step-by-step instructions to create the file.
6. End by asking the user to confirm before sending the next file.

BUILD AND ERRORS
- When the user pastes a build error or screenshot, find the exact file and line, then send the full corrected file with its name and path.

R&D MODE
- For new ideas: check feasibility, compare options with pros and cons, mention cost (free vs paid) and risks, then suggest a step-by-step plan.

HONESTY
- Never claim you ran or tested code. If unsure, say so.
- Never write shortcut versions. Build every program fully, even demos.
- The user works only from a phone, so keep replies short and clear.`;

const MAX_MESSAGES = 30;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "Use POST" }, 405);
    }
    if (env.APP_SECRET && request.headers.get("X-Agha-Key") !== env.APP_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400);
    }

    const messages = Array.isArray(body.messages)
      ? body.messages.slice(-MAX_MESSAGES)
      : [];
    if (messages.length === 0) {
      return json({ error: "No messages" }, 400);
    }

    const providers = [
      { name: "gemini", run: () => callGemini(env, messages) },
      { name: "groq", run: () => callGroq(env, messages) },
      { name: "openrouter", run: () => callOpenRouter(env, messages) },
    ];

    const errors = [];
    for (const p of providers) {
      try {
        const reply = await p.run();
        if (reply) {
          return json({ reply: reply, provider: p.name });
        }
        errors.push(p.name + ": empty reply");
      } catch (e) {
        errors.push(p.name + ": " + e.message);
      }
    }
    return json({ error: "All providers failed", details: errors }, 502);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function postJson(url, headers, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error("HTTP " + res.status + " " + text.slice(0, 200));
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(env, messages) {
  if (!env.GEMINI_API_KEY) throw new Error("no key");
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent";
  const data = await postJson(
    url,
    { "x-goog-api-key": env.GEMINI_API_KEY },
    {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content) }],
      })),
    }
  );
  const parts =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts) ||
    [];
  return parts.map((p) => p.text || "").join("").trim();
}

async function callOpenAiStyle(url, key, model, messages) {
  const data = await postJson(
    url,
    { Authorization: "Bearer " + key },
    {
      model: model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content),
        })),
      ],
    }
  );
  const choice = data.choices && data.choices[0];
  return ((choice && choice.message && choice.message.content) || "").trim();
}

async function callGroq(env, messages) {
  if (!env.GROQ_API_KEY) throw new Error("no key");
  return callOpenAiStyle(
    "https://api.groq.com/openai/v1/chat/completions",
    env.GROQ_API_KEY,
    env.GROQ_MODEL || "llama-3.3-70b-versatile",
    messages
  );
}

async function callOpenRouter(env, messages) {
  if (!env.OPENROUTER_API_KEY) throw new Error("no key");
  return callOpenAiStyle(
    "https://openrouter.ai/api/v1/chat/completions",
    env.OPENROUTER_API_KEY,
    env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
    messages
  );
}
