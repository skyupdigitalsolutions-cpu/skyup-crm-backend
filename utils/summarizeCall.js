// utils/summarizeCall.js
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function summarizeCallTranscript(transcript, contactName = 'the customer') {
  if (!transcript || transcript.trim().length < 20) {
    return {
      summary:       'Transcript too short to summarize.',
      keyPoints:     [],
      sentiment:     'Neutral',
      nextAction:    'Review the recording manually.',
      suggestedTemp: null,
    };
  }

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',   // cheapest — works great. Use 'gpt-4o' for better quality
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: 'You are a CRM assistant. Always respond with valid JSON only. No markdown, no extra text.',
      },
      {
        role: 'user',
        content: `Analyze this sales call transcript for contact "${contactName}":

"""
${transcript}
"""

Respond ONLY with this JSON:
{
  "summary": "2-3 sentence summary of the call",
  "keyPoints": ["point 1", "point 2"],
  "sentiment": "Positive" | "Neutral" | "Negative",
  "nextAction": "specific next step for the agent",
  "suggestedTemp": "Hot" | "Warm" | "Cold" | null
}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() || '';
  const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return {
      summary:       raw.slice(0, 300) || 'Could not parse summary.',
      keyPoints:     [],
      sentiment:     'Neutral',
      nextAction:    'Review manually.',
      suggestedTemp: null,
    };
  }

  return {
    summary:       parsed.summary       || '',
    keyPoints:     Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    sentiment:     ['Positive', 'Neutral', 'Negative'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral',
    nextAction:    parsed.nextAction    || '',
    suggestedTemp: ['Hot', 'Warm', 'Cold'].includes(parsed.suggestedTemp) ? parsed.suggestedTemp : null,
  };
}

module.exports = { summarizeCallTranscript };