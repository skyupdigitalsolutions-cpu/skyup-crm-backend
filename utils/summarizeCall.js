// utils/summarizeCall.js
// Uses AssemblyAI LeMUR — no OpenAI dependency required.
const { AssemblyAI } = require('assemblyai');
const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

// ── LeMUR model to use ────────────────────────────────────────────────────────
// Options: 'anthropic/claude-sonnet-4-5' | 'anthropic/claude-haiku-3-5' (cheaper/faster)
const LLM_MODEL = 'anthropic/claude-haiku-4-5-20251001';

// ── Summarize a single call transcript via LeMUR ──────────────────────────────
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

  // If we have a transcriptId (from AssemblyAI), use LeMUR directly.
  // Fallback: supply transcript text as context if no ID available.
  const lemurParams = transcriptId
    ? {
        transcript_ids: [transcriptId],
        final_model: LEMUR_MODEL,
        max_output_size: 600,
      }
    : {
        // LeMUR "input_text" mode — pass raw text when no transcript_id exists
        input_text: transcript,
        final_model: LEMUR_MODEL,
        max_output_size: 600,
      };

  lemurParams.prompt = `Analyze this sales call transcript for contact "${contactName}".

Respond ONLY with this JSON (no markdown, no extra text):
{
  "summary": "2-3 sentence summary of the call",
  "keyPoints": ["point 1", "point 2"],
  "sentiment": "Positive" | "Neutral" | "Negative",
  "nextAction": "specific next step for the agent",
  "suggestedTemp": "Hot" | "Warm" | "Cold" | null
}`;

  const { response } = await client.lemur.task(lemurParams);
  const raw   = (response || '').trim();
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
// `summaries` is an array of { summary, keyPoints[], sentiment, nextAction, suggestedTemp, calledAt? }
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

  // Build a compact text block — one numbered entry per call
  const callsText = summaries
    .map((s, i) => {
      const date = s.calledAt ? new Date(s.calledAt).toLocaleDateString('en-IN') : `Call ${i + 1}`;
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

  const { response } = await client.lemur.task({
    input_text:     callsText,   // pass the pre-built text directly (no transcript IDs needed here)
    final_model:    LEMUR_MODEL,
    max_output_size: 800,
    prompt: `Below are AI summaries of ${summaries.length} calls with lead "${contactName}". Synthesize them into one master summary.

Respond ONLY with this JSON (no markdown, no extra text):
{
  "overallSummary": "3-4 sentence synthesis of the entire relationship so far",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "overallSentiment": "Positive" | "Neutral" | "Negative",
  "relationshipStatus": "one sentence describing where this lead stands",
  "recommendedNextAction": "the single best next step for the agent",
  "suggestedTemp": "Hot" | "Warm" | "Cold" | null
}`,
  });

  const raw   = (response || '').trim();
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
