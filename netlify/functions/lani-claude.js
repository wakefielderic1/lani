const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_HISTORY = 20;
const SUMMARY_THRESHOLD = 10;
const TIMEOUT_MS = 20000;

const ESCALATION_KEYWORDS = [
  "emergency", "urgente", "urgent", "problema grave", "accidente",
  "robo", "theft", "stolen", "fire", "fuego", "incendio",
  "queja", "complaint", "demand", "lawsuit", "legal",
  "hurt", "herido", "injured", "ambulance", "ambulancia",
  "police", "policia", "help me", "ayúdame", "ayudame"
];

function detectEscalation(message) {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(keyword => lower.includes(keyword));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms)
    )
  ]);
}

async function summarizeHistory(messages, systemPrompt) {
  const summaryPrompt = `Summarize this conversation in 3-4 sentences, keeping key details like names, dates, room preferences, and any issues mentioned:\n\n${messages.map(m => `${m.role}: ${m.content}`).join("\n")}`;

  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: summaryPrompt }]
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text || "";
}

// Detecta qué propiedad eligió el huésped basándose en su mensaje
async function detectPropertyFromMessage(userMessage, propertiesList) {
  const propertiesText = propertiesList.map((p, i) =>
    `${i + 1}. property_id: "${p.property_id}" | name: "${p.name}" | location: "${p.location || ""}"`
  ).join("\n");

  const detectionPrompt = `You are helping identify which hotel a guest wants to contact.

Available properties:
${propertiesText}

Guest message: "${userMessage}"

Instructions:
- If the guest clearly refers to one property (by name, number, location, or partial match), return that property_id.
- If the message is ambiguous and could match more than one property, return "AMBIGUOUS".
- If the message doesn't seem to be choosing a property at all, return "NONE".

Respond ONLY with the property_id value, "AMBIGUOUS", or "NONE". No explanation.`;

  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{ role: "user", content: detectionPrompt }]
    })
  });

  const data = await response.json();
  return (data.content?.[0]?.text || "NONE").trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    let systemPrompt, userMessage, history, ownerWhatsapp, propertyId, propertiesListRaw;

    const contentType = event.headers["content-type"] || "";

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(event.body);
      systemPrompt = params.get("systemPrompt") || "";
      userMessage = params.get("userMessage");
      history = params.get("history") || "[]";
      ownerWhatsapp = params.get("ownerWhatsapp") || "";
      propertyId = params.get("propertyId") || "";
      propertiesListRaw = params.get("propertiesList") || "[]";
    } else {
      const body = JSON.parse(event.body);
      systemPrompt = body.systemPrompt || "";
      userMessage = body.userMessage;
      history = body.history || "[]";
      ownerWhatsapp = body.ownerWhatsapp || "";
      propertyId = body.propertyId || "";
      propertiesListRaw = body.propertiesList || "[]";
    }

    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing userMessage" })
      };
    }

    // Parsear lista de propiedades
    let propertiesList = [];
    try {
      propertiesList = JSON.parse(propertiesListRaw);
    } catch (e) {
      propertiesList = [];
    }

    // ─────────────────────────────────────────────
    // MODO IDENTIFICACIÓN — no hay propertyId aún
    // ─────────────────────────────────────────────
    if (!propertyId && propertiesList.length > 0) {

      // Intentar detectar si el huésped ya mencionó un hotel
      const detected = await detectPropertyFromMessage(userMessage, propertiesList);

      if (detected !== "NONE" && detected !== "AMBIGUOUS" && propertiesList.find(p => p.property_id === detected)) {
        // Detección exitosa — confirmar y arrancar
        const confirmedProperty = propertiesList.find(p => p.property_id === detected);
        const confirmMsg = `Hi! I'm LANI, your virtual assistant for *${confirmedProperty.name}*. How can I help you today? 😊`;

        const updatedMessages = [
          { role: "user", content: userMessage },
          { role: "assistant", content: confirmMsg }
        ];

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reply: confirmMsg,
            updatedHistory: JSON.stringify(updatedMessages),
            needsEscalation: false,
            escalationKeyword: null,
            detectedPropertyId: detected
          })
        };
      }

      // No se detectó o es ambiguo — preguntar al huésped
      const propertyOptions = propertiesList.map((p, i) =>
        `${i + 1}. ${p.name}${p.location ? ` — ${p.location}` : ""}`
      ).join("\n");

      let selectionPrompt;
      if (detected === "AMBIGUOUS") {
        selectionPrompt = `Hi! I found more than one property matching your search. Which one would you like to contact?\n\n${propertyOptions}\n\nJust reply with the number or name. 😊`;
      } else {
        selectionPrompt = `Hi! I'm LANI 👋 Which property would you like to contact?\n\n${propertyOptions}\n\nJust reply with the number or name.`;
      }

      const updatedMessages = [
        { role: "user", content: userMessage },
        { role: "assistant", content: selectionPrompt }
      ];

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply: selectionPrompt,
          updatedHistory: JSON.stringify(updatedMessages),
          needsEscalation: false,
          escalationKeyword: null,
          detectedPropertyId: null
        })
      };
    }

    // ─────────────────────────────────────────────
    // MODO SELECCIÓN — propertyId vacío, historial existente
    // El huésped acaba de responder a la lista de opciones
    // ─────────────────────────────────────────────
    if (!propertyId && propertiesList.length > 0) {
      // Este bloque ya fue manejado arriba, pero por seguridad:
      const detected = await detectPropertyFromMessage(userMessage, propertiesList);
      if (detected !== "NONE" && detected !== "AMBIGUOUS") {
        const confirmedProperty = propertiesList.find(p => p.property_id === detected);
        const confirmMsg = confirmedProperty
          ? `Perfect! Connecting you with *${confirmedProperty.name}*. How can I help you? 😊`
          : "I'm not sure which property you mean. Could you type the exact name or number from the list?";

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reply: confirmMsg,
            updatedHistory: JSON.stringify([{ role: "user", content: userMessage }, { role: "assistant", content: confirmMsg }]),
            needsEscalation: false,
            escalationKeyword: null,
            detectedPropertyId: detected !== "NONE" && detected !== "AMBIGUOUS" ? detected : null
          })
        };
      }
    }

    // ─────────────────────────────────────────────
    // MODO NORMAL — propertyId existe, responder como LANI
    // ─────────────────────────────────────────────
    if (!systemPrompt) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing systemPrompt for known property" })
      };
    }

    // Parsear historial
    let previousMessages = [];
    let conversationSummary = "";

    try {
      const parsed = JSON.parse(history);

      if (parsed.summary) {
        conversationSummary = parsed.summary;
        previousMessages = parsed.messages || [];
      } else {
        previousMessages = Array.isArray(parsed) ? parsed : [];
      }

      if (previousMessages.length >= SUMMARY_THRESHOLD) {
        const summary = await summarizeHistory(previousMessages, systemPrompt);
        conversationSummary = summary;
        previousMessages = previousMessages.slice(-4);
      } else if (previousMessages.length > MAX_HISTORY) {
        previousMessages = previousMessages.slice(-MAX_HISTORY);
      }

    } catch (e) {
      previousMessages = [];
    }

    const fullSystemPrompt = conversationSummary
      ? `${systemPrompt}\n\nConversation summary so far: ${conversationSummary}`
      : systemPrompt;

    const messages = [
      ...previousMessages,
      { role: "user", content: userMessage }
    ];

    const needsEscalation = detectEscalation(userMessage);

    let assistantReply;
    try {
      const response = await withTimeout(
        fetch(ANTHROPIC_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: fullSystemPrompt,
            messages: messages
          })
        }),
        TIMEOUT_MS
      );

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      assistantReply = data.content[0].text;

    } catch (err) {
      if (err.message === "TIMEOUT") {
        assistantReply = ownerWhatsapp
          ? `Sorry, I'm having a slow connection right now. Please contact us directly at ${ownerWhatsapp} for immediate assistance.`
          : "Sorry, I'm experiencing a slow connection. Please try again in a moment.";
      } else {
        assistantReply = ownerWhatsapp
          ? `I'm having technical difficulties right now. Please contact us directly at ${ownerWhatsapp}.`
          : "I'm having technical difficulties. Please try again in a moment.";
      }
    }

    const updatedMessages = [
      ...previousMessages,
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantReply }
    ];

    const updatedHistory = JSON.stringify(
      conversationSummary
        ? { summary: conversationSummary, messages: updatedMessages }
        : updatedMessages
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: assistantReply,
        updatedHistory: updatedHistory,
        needsEscalation: needsEscalation,
        escalationKeyword: needsEscalation
          ? ESCALATION_KEYWORDS.find(k => userMessage.toLowerCase().includes(k))
          : null,
        detectedPropertyId: null
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
