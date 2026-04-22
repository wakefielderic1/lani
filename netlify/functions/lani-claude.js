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

// ─────────────────────────────────────────────────────────────
// DETECCIÓN INTELIGENTE DE PROPIEDAD
// Maneja: errores ortográficos, nombres parciales, búsqueda
// por ciudad/país, y cuando el huésped no sabe el nombre exacto
// ─────────────────────────────────────────────────────────────
async function detectPropertyFromMessage(userMessage, propertiesList) {
  const propertiesText = propertiesList.map((p, i) =>
    `${i + 1}. property_id: "${p.property_id}" | name: "${p.name}" | location: "${p.location || ""}"`
  ).join("\n");

  const detectionPrompt = `You are helping identify which property a guest wants to contact based on their message.

Available properties:
${propertiesText}

Guest message: "${userMessage}"

Your job is to match the guest's message to one of the properties above. Be flexible and intelligent:
- Match partial names: "frederick hotel" → property named "Frederick"
- Match with typos: "frederik", "frederic" → "Frederick"  
- Match by location: "hotel in USA", "something in San Francisco" → properties in USA/San Francisco
- Match by country/region even if no specific name is given
- If the guest mentions a city or country that matches only ONE property, return that property_id
- If the guest mentions a city or country that matches MULTIPLE properties, return "LOCATION_MULTIPLE:[country or city they mentioned]"
- If the message is completely ambiguous with no location or name hints, return "NONE"
- If it could match more than one property and there's no location hint, return "AMBIGUOUS"

Respond ONLY with:
- The exact property_id value (e.g. "frederick")
- "AMBIGUOUS"  
- "NONE"
- "LOCATION_MULTIPLE:USA" (replace USA with the location they mentioned)

No explanation. No other text.`;

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

// Construye el mensaje de selección agrupando propiedades por país
function buildSelectionMessage(propertiesList, filterLocation) {
  let filtered = propertiesList;

  if (filterLocation) {
    const loc = filterLocation.toLowerCase();
    filtered = propertiesList.filter(p =>
      (p.location || "").toLowerCase().includes(loc)
    );
    // Si el filtro no devuelve nada, mostrar todas
    if (filtered.length === 0) filtered = propertiesList;
  }

  // Agrupar por país
  const grouped = {};
  filtered.forEach(p => {
    const parts = (p.location || "").split(",");
    const country = parts.length > 1 ? parts[parts.length - 1].trim() : (p.location || "Other");
    if (!grouped[country]) grouped[country] = [];
    grouped[country].push(p);
  });

  let optionsText = "";
  let index = 1;
  const flatList = [];

  Object.entries(grouped).forEach(([country, props]) => {
    if (Object.keys(grouped).length > 1) {
      optionsText += `\n📍 *${country}*\n`;
    }
    props.forEach(p => {
      const city = (p.location || "").split(",")[0].trim();
      optionsText += `${index}. ${p.name}${city ? ` — ${city}` : ""}\n`;
      flatList.push(p);
      index++;
    });
  });

  return { optionsText: optionsText.trim(), flatList };
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
      systemPrompt    = params.get("systemPrompt") || "";
      userMessage     = params.get("userMessage");
      history         = params.get("history") || "[]";
      ownerWhatsapp   = params.get("ownerWhatsapp") || "";
      propertyId      = params.get("propertyId") || "";
      propertiesListRaw = params.get("propertiesList") || "[]";
    } else {
      const body = JSON.parse(event.body);
      systemPrompt    = body.systemPrompt || "";
      userMessage     = body.userMessage;
      history         = body.history || "[]";
      ownerWhatsapp   = body.ownerWhatsapp || "";
      propertyId      = body.propertyId || "";
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

      const detected = await detectPropertyFromMessage(userMessage, propertiesList);

      // Detección exitosa — una sola propiedad identificada
      if (detected !== "NONE" && detected !== "AMBIGUOUS" && !detected.startsWith("LOCATION_MULTIPLE")) {
        const confirmedProperty = propertiesList.find(p => p.property_id === detected);

        if (confirmedProperty) {
          const confirmMsg = `¡Hola! Soy LANI 👋, tu asistente virtual de *${confirmedProperty.name}*. ¿En qué puedo ayudarte hoy? 😊`;

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
      }

      // Búsqueda por ubicación — múltiples propiedades en ese país/ciudad
      if (detected.startsWith("LOCATION_MULTIPLE:")) {
        const location = detected.replace("LOCATION_MULTIPLE:", "").trim();
        const { optionsText, flatList } = buildSelectionMessage(propertiesList, location);

        const selectionMsg = `Tenemos estas propiedades en *${location}*:\n\n${optionsText}\n\nResponde con el número o nombre de la que te interesa. 😊`;

        const updatedMessages = [
          { role: "user", content: userMessage },
          { role: "assistant", content: selectionMsg }
        ];

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reply: selectionMsg,
            updatedHistory: JSON.stringify(updatedMessages),
            needsEscalation: false,
            escalationKeyword: null,
            detectedPropertyId: null
          })
        };
      }

      // Ambiguo o no detectado — mostrar lista completa agrupada por país
      const { optionsText } = buildSelectionMessage(propertiesList, null);

      const selectionMsg = detected === "AMBIGUOUS"
        ? `Encontré más de una propiedad que podría coincidir. ¿Cuál te interesa?\n\n${optionsText}\n\nResponde con el número o nombre. 😊`
        : `¡Hola! Soy LANI 👋 ¿Con cuál de nuestras propiedades quieres contactar?\n\n${optionsText}\n\nResponde con el número o nombre.`;

      const updatedMessages = [
        { role: "user", content: userMessage },
        { role: "assistant", content: selectionMsg }
      ];

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply: selectionMsg,
          updatedHistory: JSON.stringify(updatedMessages),
          needsEscalation: false,
          escalationKeyword: null,
          detectedPropertyId: null
        })
      };
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
          ? `Lo siento, tengo una conexión lenta en este momento. Por favor contáctanos directamente al ${ownerWhatsapp} para ayuda inmediata.`
          : "Lo siento, estoy experimentando una conexión lenta. Por favor intenta de nuevo en un momento.";
      } else {
        assistantReply = ownerWhatsapp
          ? `Estoy teniendo dificultades técnicas. Por favor contáctanos directamente al ${ownerWhatsapp}.`
          : "Estoy teniendo dificultades técnicas. Por favor intenta de nuevo en un momento.";
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
