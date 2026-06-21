// utils/summarizeCall.js
// Summarization via Groq (OpenAI-compatible chat completions API)
// Docs: https://console.groq.com/docs/api-reference#chat-create
//
// Switched from OpenAI gpt-4o-mini → Groq. Groq's endpoint mirrors OpenAI's
// request/response shape, so only the URL, key, and model changed.
// Free within Groq's free-tier rate limits; paid beyond them.

const axios = require('axios');
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// llama-3.3-70b-versatile → best balance of quality + reliable JSON output.
// For lower cost / higher speed (but messier JSON) use 'llama-3.1-8b-instant'.
// NOTE: Groq's model list changes over time — confirm the name is still live
// at https://console.groq.com/docs/models if you get a "model not found" error.
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Internal helper: call the LLM
async function callLLM(systemPrompt, userContent, maxTokens = 600) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set. Add it to your environment variables.');
  }

  const { data } = await axios.post(
    GROQ_API_URL,
    {
      model:       GROQ_MODEL,
      max_tokens:  maxTokens,
      temperature: 0,
      // Force valid JSON. Requires the word "JSON" to appear in the prompt
      // (it does, in both prompts below). Remove this line if you switch to a
      // model that doesn't support JSON mode.
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type':  'application/json',
      },
    }
  );

  // Groq returns the same shape as OpenAI: { choices: [{ message: { content } }] }
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ── Summarize a single call transcript ────────────────────────────────────────
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

  const raw = await callLLM(
    'You are a CRM assistant. Always respond with valid JSON only. No markdown, no extra text.',
    `Analyze this sales call transcript for contact "${contactName}":

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
    600
  );

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

// ── Combine all per-call summaries for a lead into one master summary ─────────
async function combineLeadSummaries(summaries, contactName = 'the customer') {
  if (!summaries || summaries.length === 0) {
    return {
      overallSummary:        'No call summaries available for this lead.',
      keyInsights:           [],
      overallSentiment:      'Neutral',
      relationshipStatus:    'No interactions recorded.',
      recommendedNextAction: 'Initiate first contact.',
      suggestedTemp:         null,
      totalCalls:            0,
    };
  }

  if (summaries.length === 1) {
    const s = summaries[0];
    return {
      overallSummary:        s.summary    || 'Single call summary.',
      keyInsights:           s.keyPoints  || [],
      overallSentiment:      s.sentiment  || 'Neutral',
      relationshipStatus:    'Only one call recorded so far.',
      recommendedNextAction: s.nextAction || 'Follow up.',
      suggestedTemp:         s.suggestedTemp || null,
      totalCalls:            1,
    };
  }

  const callsText = summaries
    .map((s, i) => {
      const date   = s.calledAt ? new Date(s.calledAt).toLocaleDateString('en-IN') : `Call ${i + 1}`;
      const points = Array.isArray(s.keyPoints) && s.keyPoints.length
        ? s.keyPoints.map(p => `  • ${p}`).join('\n')
        : '';
      return [
        `[Call ${i + 1} — ${date}]`,
        `Summary: ${s.summary    || 'N/A'}`,
        points ? `Key Points:\n${points}` : '',
        `Sentiment: ${s.sentiment  || 'Neutral'}`,
        `Next Action: ${s.nextAction || 'N/A'}`,
        s.suggestedTemp ? `Temperature: ${s.suggestedTemp}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const raw = await callLLM(
    'You are a CRM assistant. Always respond with valid JSON only. No markdown, no extra text.',
    `Below are AI summaries of ${summaries.length} calls with lead "${contactName}". Synthesize into one master summary.

${callsText}

Respond ONLY with this JSON:
{
  "overallSummary": "3-4 sentence synthesis of the entire relationship so far",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "overallSentiment": "Positive" | "Neutral" | "Negative",
  "relationshipStatus": "one sentence describing where this lead stands",
  "recommendedNextAction": "the single best next step for the agent",
  "suggestedTemp": "Hot" | "Warm" | "Cold" | null
}`,
    800
  );

  const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try { parsed = JSON.parse(clean); }
  catch {
    return {
      overallSummary:        raw.slice(0, 400) || 'Could not parse combined summary.',
      keyInsights:           [],
      overallSentiment:      'Neutral',
      relationshipStatus:    '',
      recommendedNextAction: 'Review call summaries manually.',
      suggestedTemp:         null,
      totalCalls:            summaries.length,
    };
  }

  return {
    overallSummary:        parsed.overallSummary        || '',
    keyInsights:           Array.isArray(parsed.keyInsights) ? parsed.keyInsights : [],
    overallSentiment:      ['Positive','Neutral','Negative'].includes(parsed.overallSentiment) ? parsed.overallSentiment : 'Neutral',
    relationshipStatus:    parsed.relationshipStatus    || '',
    recommendedNextAction: parsed.recommendedNextAction || '',
    suggestedTemp:         ['Hot','Warm','Cold'].includes(parsed.suggestedTemp) ? parsed.suggestedTemp : null,
    totalCalls:            summaries.length,
  };
}

module.exports = { summarizeCallTranscript, combineLeadSummaries };
