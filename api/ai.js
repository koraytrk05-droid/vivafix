const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const requestsByIp = globalThis.__vivafixRateLimit || new Map();
globalThis.__vivafixRateLimit = requestsByIp;

function setCors(req, res) {
  const configuredOrigin =
    process.env.VIVAFIX_ALLOWED_ORIGIN ||
    "https://koraytrk05-droid.github.io";

  const requestOrigin = req.headers.origin;

  if (requestOrigin && requestOrigin !== configuredOrigin) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", configuredOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

function rateLimit(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || "unknown")
    .split(",")[0]
    .trim();

  const now = Date.now();
  const entry = requestsByIp.get(ip);

  if (!entry || now - entry.startedAt > RATE_WINDOW_MS) {
    requestsByIp.set(ip, { startedAt: now, count: 1 });
    return true;
  }

  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

function truncate(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function compactContext(context = {}) {
  return {
    tasks: Array.isArray(context.tasks)
      ? context.tasks.slice(0, 30).map((task) => ({
          title: truncate(task.title, 180),
          date: truncate(task.date, 20),
          priority: truncate(task.priority, 20),
          done: Boolean(task.done),
        }))
      : [],
    events: Array.isArray(context.events)
      ? context.events.slice(0, 30).map((event) => ({
          title: truncate(event.title, 180),
          date: truncate(event.date, 20),
          time: truncate(event.time, 12),
        }))
      : [],
    notes: Array.isArray(context.notes)
      ? context.notes.slice(-15).map((note) => ({
          title: truncate(note.title, 180),
          text: truncate(note.text, 600),
        }))
      : [],
    weather: context.weather
      ? {
          current: context.weather.current || null,
          timezone: truncate(context.weather.timezone, 80),
        }
      : null,
    location: context.location
      ? {
          name: truncate(context.location.name, 120),
          admin1: truncate(context.location.admin1, 120),
          country: truncate(context.location.country, 120),
        }
      : null,
    emails: Array.isArray(context.emails)
      ? context.emails.slice(0, 20).map((email) => ({
          from: truncate(email.from, 180),
          subject: truncate(email.subject, 220),
          date: truncate(email.date, 100),
          snippet: truncate(email.snippet, 350),
        }))
      : [],
    history: Array.isArray(context.history)
      ? context.history.slice(-10).map((entry) => ({
          role: entry.role === "ai" ? "assistant" : "user",
          text: truncate(entry.text, 1200),
        }))
      : [],
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

export default async function handler(req, res) {
  if (!setCors(req, res)) {
    return res.status(403).json({ error: "Origin nicht erlaubt." });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST ist erlaubt." });
  }

  if (!rateLimit(req)) {
    return res.status(429).json({
      error: "Zu viele Anfragen. Bitte warte kurz.",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY fehlt auf dem Server.",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Ungültiges JSON." });
    }
  }

  const message = truncate(body?.message, 4000).trim();
  if (!message) {
    return res.status(400).json({ error: "Nachricht fehlt." });
  }

  const context = compactContext(body?.context);
  const contextText = JSON.stringify(context, null, 2);

  const conversationText = context.history
    .map((entry) => `${entry.role === "assistant" ? "VIVAFIX" : "Nutzer"}: ${entry.text}`)
    .join("\n");

  const input = [
    "AKTUELLER APP-KONTEXT:",
    contextText,
    "",
    "LETZTER GESPRÄCHSVERLAUF:",
    conversationText || "(noch kein Verlauf)",
    "",
    "AKTUELLE NACHRICHT:",
    message,
  ].join("\n");

  const instructions = `
Du bist VIVAFIX, ein persönlicher digitaler Assistent.

Sprich natürlich, warm, aufmerksam und intelligent — wie ein sehr guter menschlicher Gesprächspartner.
Antworte standardmäßig auf Deutsch, außer der Nutzer wechselt die Sprache.
Formuliere abwechslungsreich und vermeide starre Standardsätze.
Gehe direkt auf die konkrete Nachricht ein und berücksichtige den Gesprächsverlauf.
Nutze Aufgaben, Termine, Notizen, Wetter und E-Mail-Metadaten aus dem App-Kontext nur, wenn sie relevant sind.
Erfinde keine Informationen, die nicht im Kontext stehen.
Wenn etwas unklar ist, stelle genau eine sinnvolle Rückfrage.
Sei hilfreich, aber nicht übertrieben förmlich und nicht künstlich enthusiastisch.
Halte einfache Antworten kompakt; erkläre komplexe Themen verständlich.
Bei sensiblen E-Mails oder persönlichen Daten zitiere nur das Nötigste.
Behaupte niemals, eine Aufgabe, einen Termin oder eine E-Mail wirklich verändert zu haben.
Bei gewünschten Aktionen formuliere zuerst einen konkreten Vorschlag und bitte um Bestätigung.
Du darfst gelegentlich den Namen Koray verwenden, aber nicht in jeder Antwort.
`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions,
        input,
        max_output_tokens: 700,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data?.error?.type || response.status);
      return res.status(response.status).json({
        error: data?.error?.message || "OpenAI-Anfrage fehlgeschlagen.",
      });
    }

    const text = extractOutputText(data);
    if (!text) {
      return res.status(502).json({
        error: "Die KI hat keine Textantwort geliefert.",
      });
    }

    return res.status(200).json({ text });
  } catch (error) {
    console.error("VIVAFIX server error:", error?.message);
    return res.status(500).json({
      error: "Der KI-Server ist momentan nicht erreichbar.",
    });
  }
}
