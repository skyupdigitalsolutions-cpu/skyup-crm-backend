// utils/summarizeCall.js
// Uses AssemblyAI LLM Gateway (replaces deprecated LeMUR — deprecated March 31, 2026).
// LLM Gateway is OpenAI-compatible: same base URL swap, same response format.
const axios = require('axios');

const ASSEMBLYAI_API_KEY = () => process.env.ASSEMBLYAI_API_KEY;

// LLM Gateway base URL + model
// claude-haiku-4-5-20251001 = fast + cheap (Claude 3.0 Haiku retired April 20, 2026)
// Swap to 'claude-sonnet-4-20250514' for higher quality summaries
const LLM_GATEWAY_URL = 'https://api.assemblyai.com/lemur/v3/generate/task';
const LLM_MODEL       = 'anthropic/claude-haiku-4-5-20251001';

// ── Internal helper: call LLM Gateway ────────────────────────────────────────
// transcriptIds: array of AssemblyAI transcript IDs (preferred — Gateway fetches text itself)
// inputText:     raw text fallback when no transcript IDs available
async function callLLMGateway({ prompt, transcriptIds = null, inputText = null, maxTokens = 600 }) {
  const body = {
    prompt,
    final_model: LLM_MODEL,
    max_output_size: maxTokens,
  };

  if (transcriptIds && transcriptIds.length > 0) {
    body.transcript_ids = transcriptIds;
  } else if (inputText) {
    body.input_text = inputText;
  } else {
    throw new Error('callLLMGateway requires either transcriptIds or inputText');
  }

  const { data } = await axios.post(LLM_GATEWAY_URL, body, {
    headers: {
      authorization: ASSEMBLYAI_API_KEY(),
      'content-type': 'application/json',
    },
  });

  return (data.response || '').trim();
}

// ── Summarize a single call transcript ────────────────────────────────────────
async function summarizeCallTranscript(transcript, contactName = 'the customer', transcriptId = null) {
  if (!transcript || transcript.trim().length < 20) {
    return {
      summary:       'Transcript too short to summarize.',
      keyPoints:     [],
      sentiment:     'Neutral',
      nextAction:    'Review the recording manually.',
      suggestedTemp: null,
    };
  }

  const prompt = `Analyze this sales call transcript for contact "${contactName}".

Respond ONLY with this JSON (no markdown, no extra text):
{
  "summary": "2-3 sentence summary of the call",
  "keyPoints": ["point 1", "point 2"],
  "sentiment": "Positive" | "Neutral" | "Negative",
  "nextAction": "specific next step for the agent",
  "suggestedTemp": "Hot" | "Warm" | "Cold" | null
}`;

  const raw = await callLLMGateway({
    prompt,
    transcriptIds: transcriptId ? [transcriptId] : null,
    inputText:     transcriptId ? null : transcript,
    maxTokens:     600,
  });

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
// summaries: array of { summary, keyPoints[], sentiment, nextAction, suggestedTemp, calledAt? }
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
      overallSummary:        s.summary || 'Single call summary.',
      keyInsights:           s.keyPoints || [],
      overallSentiment:      s.sentiment || 'Neutral',
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
        `Summary: ${s.summary || 'N/A'}`,
        points ? `Key Points:\n${points}` : '',
        `Sentiment: ${s.sentiment || 'Neutral'}`,
        `Next Action: ${s.nextAction || 'N/A'}`,
        s.suggestedTemp ? `Temperature: ${s.suggestedTemp}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const raw = await callLLMGateway({
    prompt: `Below are AI summaries of ${summaries.length} calls with lead "${contactName}". Synthesize into one master summary.

${callsText}

Respond ONLY with this JSON (no markdown, no extra text):
{
  "overallSummary": "3-4 sentence synthesis of the entire relationship so far",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "overallSentiment": "Positive" | "Neutral" | "Negative",
  "relationshipStatus": "one sentence describing where this lead stands",
  "recommendedNextAction": "the single best next step for the agent",
  "suggestedTemp": "Hot" | "Warm" | "Cold" | null
}`,
    inputText: callsText,
    maxTokens: 800,
  });

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
