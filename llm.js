// llm.js
import axios from 'axios'
import 'dotenv/config'

const llmClient = axios.create({
  baseURL: process.env.LLM_BASE_URL,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.LLM_API_KEY}`
  }
})

/**
 * 调用大模型
 * @param {string} systemPrompt 系统提示词
 * @param {Array} messages 历史消息 [{role:'user'|'assistant', content}]
 * @param {Object} options 额外参数
 */
export const callLLM = async (systemPrompt, messages, options = {}) => {
  const body = {
    model: options.model || process.env.LLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 800,
    stream: false
  }

  const { data } = await llmClient.post('/chat/completions', body)

  return {
    content: data?.choices?.[0]?.message?.content ?? '',
    usage: data?.usage ?? {}
  }
}