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
      model: "claude-sonnet-4-20250514",
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

NUMBER SELECTION:
- If the guest writes just a number like "1", "2", "3" → match to that numbered property in the list above
- "1" → first property in the list, "2" → second property, etc.

LOCATION MATCHING (handle any language and variation):
- "USA", "United States", "Estados Unidos", "EUA", "EEUU", "America", "Norteamerica" → all mean United States
- "Filipinas", "Philippines", "Pilipinas", "Pinas", "PH" → all mean Philippines
- "México", "Mexico", "Mex" → all mean Mexico
- Apply the same multilingual logic to ANY country mentioned
- City names also count: "San Francisco", "Manila", "Siargao", "Palawan", etc.
- If guest says "hoteles en X" or "hotel in X" or "algo en X" — treat X as a location filter

DECISION RULES:
- If location or name matches exactly ONE property → return that property_id
- If the guest wrote a number → return the property_id at that position in the list
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 50,
      messages: [{ role: "user", content: detectionPrompt }]
    })
  });

  const data = await response.json();
  return (data.content?.[0]?.text || "NONE").trim();
}

// ─────────────────────────────────────────────────────────────
// NORMALIZACIÓN DE PAÍSES
// ─────────────────────────────────────────────────────────────
const COUNTRY_ALIASES = {
  "usa": "United States", "us": "United States", "united states": "United States",
  "united states of america": "United States", "estados unidos": "United States",
  "eua": "United States", "eeuu": "United States", "america": "United States",
  "norteamerica": "United States", "north america": "United States",
  "u.s.": "United States", "u.s.a.": "United States",
  "philippines": "Philippines", "filipinas": "Philippines", "pilipinas": "Philippines",
  "pinas": "Philippines", "ph": "Philippines", "phils": "Philippines",
  "mexico": "Mexico", "méxico": "Mexico", "mex": "Mexico",
  "spain": "Spain", "españa": "Spain", "espana": "Spain",
  "thailand": "Thailand", "tailandia": "Thailand", "thai": "Thailand",
  "indonesia": "Indonesia", "bali": "Indonesia",
  "japan": "Japan", "japon": "Japan", "japón": "Japan",
  "france": "France", "francia": "France",
  "italy": "Italy", "italia": "Italy",
  "portugal": "Portugal",
  "colombia": "Colombia",
  "peru": "Peru", "perú": "Peru",
  "argentina": "Argentina",
  "brazil": "Brazil", "brasil": "Brazil",
  "australia": "Australia",
  "uk": "United Kingdom", "united kingdom": "United Kingdom", "england": "United Kingdom",
  "britain": "United Kingdom", "reino unido": "United Kingdom", "inglaterra": "United Kingdom",
  "canada": "Canada", "canadá": "Canada",
};

function normalizeLocation(loc) {
  if (!loc) return loc;
  const lower = loc.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] || loc;
}

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

// ─────────────────────────────────────────────────────────────
// LIMPIEZA DE MARKDOWN PARA WHATSAPP
// ─────────────────────────────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')
    .replace(/^- /gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatForWhatsApp(text) {
  text = text.replace(/\|(.+)\|/g, (match, content) => {
    if (/^[\s\-\|]+$/.test(match)) return '';
    const cells = content.split('|')
      .map(c => c.trim())
      .filter(c => c.length > 0 && !/^[-\s]+$/.test(c));
    if (cells.length === 0) return '';
    return cells.join(': ');
  });

  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/#{1,6}\s+(.+)/g, '*$1*')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2')
    .replace(/^---+$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
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
      systemPrompt      = params.get("systemPrompt") || "";
      userMessage       = params.get("userMessage");
      history           = params.get("history") || "[]";
      ownerWhatsapp     = params.get("ownerWhatsapp") || "";
      propertyId        = params.get("propertyId") || "";
      propertiesListRaw = params.get("propertiesList") || "[]";
    } else {
      const body = JSON.parse(event.body);
      systemPrompt      = body.systemPrompt || "";
      userMessage       = body.userMessage;
      history           = body.history || "[]";
      ownerWhatsapp     = body.ownerWhatsapp || "";
      propertyId        = body.propertyId || "";
      propertiesListRaw = body.propertiesList || "[]";
    }

    if (!userMessage) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing userMessage" })
      };
    }

    // Parsear lista completa de propiedades
    let propertiesList = [];
    try { propertiesList = JSON.parse(propertiesListRaw); } catch (e) { propertiesList = []; }

    // ─────────────────────────────────────────────
    // MODO IDENTIFICACIÓN — no hay propertyId aún
    // ─────────────────────────────────────────────
    if (!propertyId && propertiesList.length > 0) {

      let pendingFlatList = null;
      try {
        const parsedHistory = JSON.parse(history);
        const msgs = Array.isArray(parsedHistory) ? parsedHistory : (parsedHistory.messages || []);
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant" && msgs[i].__flatList) {
            pendingFlatList = msgs[i].__flatList;
            break;
          }
        }
      } catch (e) {}

      const listToDetect = pendingFlatList || propertiesList;
      const detected = await detectPropertyFromMessage(userMessage, listToDetect);

      if (detected !== "NONE" && detected !== "AMBIGUOUS" && !detected.startsWith("LOCATION_MULTIPLE")) {
        const confirmedProperty = listToDetect.find(p => p.property_id === detected);

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

      if (detected.startsWith("LOCATION_MULTIPLE:")) {
        const location = detected.replace("LOCATION_MULTIPLE:", "").trim();
        const { optionsText, flatList } = buildSelectionMessage(propertiesList, location);

        const selectionMsg = `Tenemos estas propiedades en *${location}*:\n\n${optionsText}\n\nResponde con el número o nombre de la que te interesa. 😊`;

        const updatedMessages = [
          { role: "user", content: userMessage },
          { role: "assistant", content: selectionMsg, __flatList: flatList }
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

      const { optionsText, flatList } = buildSelectionMessage(propertiesList, null);

      const selectionMsg = detected === "AMBIGUOUS"
        ? `Encontré más de una propiedad que podría coincidir. ¿Cuál te interesa?\n\n${optionsText}\n\nResponde con el número o nombre. 😊`
        : `¡Hola! Soy LANI 👋 ¿Con cuál de nuestras propiedades quieres contactar?\n\n${optionsText}\n\nResponde con el número o nombre.`;

      const updatedMessages = [
        { role: "user", content: userMessage },
        { role: "assistant", content: selectionMsg, __flatList: flatList }
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

      // Limpiar __flatList del historial antes de mandarlo a Claude
      previousMessages = previousMessages.map(m => {
        const clean = { role: m.role, content: m.content };
        return clean;
      });

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

    // ─────────────────────────────────────────────
    // REGLA DE INTEGRIDAD DE DATOS
    // Evita que LANI invente información no provista
    // ─────────────────────────────────────────────
    const dataIntegrityRule = `

CRITICAL RULE — DATA INTEGRITY:
You must ONLY use information explicitly provided in this system prompt to answer guest questions.
If a guest asks about something not covered here (room types, prices, amenities, policies, availability, or any other detail), respond exactly like this:
"I don't have that information available right now. Please contact [owner name] directly for assistance."
NEVER invent, assume, or borrow details from other properties or your general knowledge.
If a field is empty or not mentioned in this prompt, treat it as unknown — do not fill in the gap.
This rule overrides everything else.`;

    const fullSystemPrompt = conversationSummary
      ? `${systemPrompt}${dataIntegrityRule}\n\nConversation summary so far: ${conversationSummary}`
      : `${systemPrompt}${dataIntegrityRule}`;

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
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: fullSystemPrompt,
            messages: messages
          })
        }),
        TIMEOUT_MS
      );

      const data = await response.json();

      if (data.error) throw new Error(data.error.message);

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
        reply: stripMarkdown(assistantReply),
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
