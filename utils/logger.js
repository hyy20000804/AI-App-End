// utils/logger.js

export function logAIUsage ({
  requestId,
  sessionId,
  intent,
  historyRounds,
  hasSummary,
  response,
  duration
}) {
  console.log('[AI_USAGE]', {
    requestId,
    sessionId,
    intent,
    historyRounds,
    hasSummary,

    promptTokens: response?.usage?.prompt_tokens ?? 0,

    completionTokens: response?.usage?.completion_tokens ?? 0,

    totalTokens: response?.usage?.total_tokens ?? 0,

    duration: `${duration}ms`
  })
}
