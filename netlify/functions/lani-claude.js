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

NAME MATCHING:
- Match partial names: "frederick hotel" → property named "Frederick"
- Match with typos or spelling variations: "frederik", "frederic", "bay lantern" → match closest property
- Match nicknames or shortened names

LOCATION MATCHING (handle any language and variation):
- "USA", "United States", "Estados Unidos", "EUA", "EEUU", "America", "Norteamerica" → all mean United States
- "Filipinas", "Philippines", "Pilipinas", "Pinas", "PH" → all mean Philippines
- "México", "Mexico", "Mex" → all mean Mexico
- "España", "Spain", "Espana" → all mean Spain
- "Tailandia", "Thailand", "Thai" → all mean Thailand
- Apply the same multilingual logic to ANY country mentioned
- City names also count: "San Francisco", "Manila", "Siargao", "Palawan", etc.
- If guest says "hoteles en X" or "hotel in X" or "algo en X" — treat X as a location filter

DECISION RULES:
- If location or name matches exactly ONE property → return that property_id
- If location matches MULTIPLE properties → return "LOCATION_MULTIPLE:[the location term the guest used, as-is]"
- If message has no useful hints → return "NONE"
- If hints exist but match multiple and no location → return "AMBIGUOUS"

Respond ONLY with one of:
- The exact property_id (e.g. "frederick")
- "AMBIGUOUS"
- "NONE"
- "LOCATION_MULTIPLE:USA" (use whatever location term the guest actually wrote)

No explanation. No punctuation. No other text.`;

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

// ─────────────────────────────────────────────────────────────
// NORMALIZACIÓN DE PAÍSES
// Mapea variaciones en cualquier idioma al nombre canónico
// ─────────────────────────────────────────────────────────────
const COUNTRY_ALIASES = {
  // USA
  "usa": "United States",
  "us": "United States",
  "united states": "United States",
  "united states of america": "United States",
  "estados unidos": "United States",
  "eua": "United States",
  "eeuu": "United States",
  "america": "United States",
  "norteamerica": "United States",
  "north america": "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  // Philippines
  "philippines": "Philippines",
  "filipinas": "Philippines",
  "pilipinas": "Philippines",
  "pinas": "Philippines",
  "ph": "Philippines",
  "phils": "Philippines",
  // Mexico
  "mexico": "Mexico",
  "méxico": "Mexico",
  "mex": "Mexico",
  // Spain
  "spain": "Spain",
  "españa": "Spain",
  "espana": "Spain",
  // Thailand
  "thailand": "Thailand",
  "tailandia": "Thailand",
  "thai": "Thailand",
  // Indonesia
  "indonesia": "Indonesia",
  "bali": "Indonesia",
  // Japan
  "japan": "Japan",
  "japon": "Japan",
  "japón": "Japan",
  // France
  "france": "France",
  "francia": "France",
  // Italy
  "italy": "Italy",
  "italia": "Italy",
  // Portugal
  "portugal": "Portugal",
  // Colombia
  "colombia": "Colombia",
  // Peru
  "peru": "Peru",
  "perú": "Peru",
  // Argentina
  "argentina": "Argentina",
  // Brazil
  "brazil": "Brazil",
  "brasil": "Brazil",
  // Australia
  "australia": "Australia",
  // UK
  "uk": "United Kingdom",
  "united kingdom": "United Kingdom",
  "england": "United Kingdom",
  "britain": "United Kingdom",
  "reino unido": "United Kingdom",
  "inglaterra": "United Kingdom",
  // Canada
  "canada": "Canada",
  "canadá": "Canada",
};

// Normaliza un string de ubicación al nombre canónico de país si existe
function normalizeLocation(loc) {
  if (!loc) return loc;
  const lower = loc.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] || loc;
}

// Verifica si dos strings de ubicación son equivalentes
function locationsMatch(a, b) {
  if (!a || !b) return false;
  const normA = normalizeLocation(a).toLowerCase();
  const normB = normalizeLocation(b).toLowerCase();
  return normA.includes(normB) || normB.includes(normA);
}
function buildSelectionMessage(propertiesList, filterLocation) {
  let filtered = propertiesList;

  if (filterLocation) {
    const normalizedFilter = normalizeLocation(filterLocation).toLowerCase();
    filtered = propertiesList.filter(p => {
      const propLocation = (p.location || "").toLowerCase();
      const propNormalized = normalizeLocation(p.location || "").toLowerCase();
      return propLocation.includes(normalizedFilter) ||
             propNormalized.includes(normalizedFilter) ||
             normalizedFilter.includes(propNormalized) ||
             locationsMatch(filterLocation, p.location);
    });
    if (filtered.length === 0) filtered = propertiesList;
  }

  // Agrupar por país (parte después de la última coma)
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


// ─────────────────────────────────────────────────────────────
// LIMPIEZA DE MARKDOWN PARA WHATSAPP
// Claude usa markdown estándar, WhatsApp tiene su propio formato
// ─────────────────────────────────────────────────────────────
function formatForWhatsApp(text) {
  return text
    // **negrita** → *negrita* (WhatsApp bold)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // ### Encabezados → solo texto en mayúsculas
    .replace(/#{1,6}\s+(.+)/g, '*$1*')
    // ~~tachado~~ → eliminar
    .replace(/~~(.+?)~~/g, '$1')
    // `código inline` → eliminar backticks
    .replace(/`(.+?)`/g, '$1')
    // Bloques de código ```...``` → eliminar
    .replace(/```[\s\S]*?```/g, '')
    // [texto](url) → texto: url
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2')
    // Limpiar líneas con solo espacios
    .replace(/[ \t]+\n/g, '\n')
    // Máximo 2 saltos de línea consecutivos
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

      assistantReply = formatForWhatsApp(data.content[0].text);

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
