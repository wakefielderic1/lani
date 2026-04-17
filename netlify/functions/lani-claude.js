exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    let systemPrompt, userMessage;

    const contentType = event.headers["content-type"] || "";

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(event.body);
      systemPrompt = params.get("systemPrompt");
      userMessage = params.get("userMessage");
    } else {
      const body = JSON.parse(event.body);
      systemPrompt = body.systemPrompt;
      userMessage = body.userMessage;
    }

    if (!systemPrompt || !userMessage) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing systemPrompt or userMessage" })
      };
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: data.error.message })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ reply: data.content[0].text })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
