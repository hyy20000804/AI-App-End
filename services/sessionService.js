// services/sessionService.js

import { v4 as uuidv4 } from 'uuid'
import { OpenAI } from 'openai'

// ==============================
// 配置
// ==============================

export const MAX_HISTORY_ROUNDS = 6

export const SUMMARY_TRIGGER_ROUNDS = 12

export const SESSION_TTL = 30 * 60 * 1000

export const MAX_SUMMARY_LENGTH = 1000

// ==============================
// OpenAI
// ==============================

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
})

// ==============================
// Session Map
// ==============================

const chatSessions = new Map()

// ==============================
// 创建 Session
// ==============================

function createSession () {
  return {
    history: [],

    summary: '',

    context: {
      currentDeviceId: null,
      currentDeviceName: null,
      currentSystem: null,
      lastIntent: null
    },

    updatedAt: Date.now()
  }
}

// ==============================
// 获取 Session
// ==============================

export function getSession (sessionId) {
  if (!sessionId) {
    return null
  }

  let session = chatSessions.get(sessionId)

  if (!session) {
    session = createSession()

    chatSessions.set(sessionId, session)

    console.log('[SESSION_AUTO_CREATED]', {
      sessionId,
      totalSessions: chatSessions.size
    })
  }

  session.updatedAt = Date.now()

  return session
}

// ==============================
// 创建 Session ID
// ==============================

export function createSessionId () {
  const sessionId = uuidv4()

  const session = createSession()

  chatSessions.set(sessionId, session)

  console.log('[SESSION_CREATED]', {
    sessionId,
    totalSessions: chatSessions.size
  })

  return sessionId
}

// ==============================
// 添加历史消息
// ==============================

export function addHistory (session, userMessage, assistantMessage) {
  session.history.push(
    {
      role: 'user',
      content: userMessage
    },
    {
      role: 'assistant',
      content: assistantMessage
    }
  )

  session.updatedAt = Date.now()
}

// ==============================
// 获取最近历史
// ==============================

export function getRecentHistory (session) {
  return session.history.slice(-MAX_HISTORY_ROUNDS * 2)
}

// ==============================
// 获取完整历史
// ==============================

export function getSessionHistory (sessionId) {
  const session = chatSessions.get(sessionId)

  if (!session) {
    return null
  }

  session.updatedAt = Date.now()

  return {
    sessionId,

    history: session.history,

    summary: session.summary,

    context: session.context,

    updatedAt: session.updatedAt
  }
}

// ==============================
// 获取 Session 简要信息
// 用于历史会话列表
// ==============================

export function getSessionPreview (sessionId) {
  const session = chatSessions.get(sessionId)

  if (!session) {
    return null
  }

  const history = session.history

  const firstUserMessage =
    history.find(item => item.role === 'user')?.content || ''

  const lastMessage = history.length > 0 ? history[history.length - 1] : null

  return {
    sessionId,

    title: firstUserMessage ? firstUserMessage.slice(0, 30) : '新对话',

    lastMessage: lastMessage?.content || '',

    messageCount: history.length,

    updatedAt: session.updatedAt
  }
}

// ==============================
// 获取所有 Session
// ==============================

export function getAllSessionPreviews () {
  return Array.from(chatSessions.entries())
    .filter(([_, session]) => {
      return session.history && session.history.length > 0
    })
    .map(([sessionId, session]) => {
      const history = session.history

      const firstUserMessage =
        history.find(item => item.role === 'user')?.content || ''

      const lastMessage =
        history.length > 0 ? history[history.length - 1] : null

      return {
        sessionId,

        title: firstUserMessage ? firstUserMessage.slice(0, 30) : '新对话',

        lastMessage: lastMessage?.content || '',

        messageCount: history.length,

        updatedAt: session.updatedAt
      }
    })
    .sort((a, b) => {
      return b.updatedAt - a.updatedAt
    })
}

// ==============================
// 清空 Session 历史
// ==============================

export function clearSessionHistory (sessionId) {
  const session = chatSessions.get(sessionId)

  if (!session) {
    return false
  }

  session.history = []

  session.summary = ''

  session.context = {
    currentDeviceId: null,
    currentDeviceName: null,
    currentSystem: null,
    lastIntent: null
  }

  session.updatedAt = Date.now()

  return true
}

// ==============================
// 删除 Session
// ==============================

export function deleteSession (sessionId) {
  return chatSessions.delete(sessionId)
}

// ==============================
// 更新 Session Context
// ==============================

export function updateSessionContext (
  session,
  { intent, device = null, system = null } = {}
) {
  session.context.lastIntent = intent || null

  if (device) {
    session.context.currentDeviceId = device.id ?? null

    session.context.currentDeviceName = device.name ?? null
  }

  if (system) {
    session.context.currentSystem = system
  }

  session.updatedAt = Date.now()
}

// ==============================
// 生成 Summary
// ==============================

export async function generateSummary (session) {
  if (session.history.length < SUMMARY_TRIGGER_ROUNDS * 2) {
    return
  }

  const history = session.history

  try {
    const response = await openai.chat.completions.create(
      {
        model: 'deepseek-v4-flash',

        messages: [
          {
            role: 'system',

            content: `
你负责压缩“融天AI”的历史对话。

请提取对后续对话仍然有价值的信息。

重点保留：
1. 用户正在关注的设备
2. 用户正在关注的系统
3. 用户已经询问过的问题
4. 已经得到的重要结论
5. 用户提出的限制条件

不要保留：
1. 客套话
2. 重复内容
3. 无意义闲聊

要求：
- 使用简洁中文
- 最多1000字
- 不要编造信息
`
          },

          {
            role: 'user',

            content: `
已有历史摘要：

${session.summary || '暂无'}

最近对话：

${JSON.stringify(history)}
`
          }
        ]
      },
      {
        timeout: 30000
      }
    )

    let summary = response.choices?.[0]?.message?.content || ''

    summary = summary.trim()

    if (summary.length > MAX_SUMMARY_LENGTH) {
      summary = summary.slice(0, MAX_SUMMARY_LENGTH)
    }

    session.summary = summary

    // 只保留最近6轮
    session.history = session.history.slice(-MAX_HISTORY_ROUNDS * 2)

    session.updatedAt = Date.now()

    console.log('[SESSION_SUMMARY]', {
      summaryLength: summary.length,

      historyRounds: session.history.length / 2
    })
  } catch (error) {
    console.error('[SESSION_SUMMARY_ERROR]', error)
  }
}

// ==============================
// 清理过期 Session
// ==============================

export function cleanupSessions () {
  const now = Date.now()

  let deleted = 0

  for (const [sessionId, session] of chatSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL) {
      chatSessions.delete(sessionId)

      deleted++
    }
  }

  if (deleted > 0) {
    console.log(`[SESSION_CLEANUP] 清理 ${deleted} 个Session`)
  }
}

// 每5分钟清理
setInterval(cleanupSessions, 5 * 60 * 1000)
