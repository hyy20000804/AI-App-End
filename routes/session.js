import express from 'express'

import {
  createSessionId,
  getSessionHistory,
  getSessionPreview,
  getAllSessionPreviews,
  clearSessionHistory,
  deleteSession
} from '../services/sessionService.js'

const router = express.Router()

// ==============================
// 创建新的 Session
// ==============================

router.post('/create', (req, res) => {
  const sessionId = createSessionId()

  res.json({
    code: 200,
    message: 'success',
    data: {
      sessionId
    }
  })
})

// ==============================
// 获取当前 Session 完整历史
// GET /session/history?sessionId=xxx
// ==============================

router.get('/history', (req, res) => {
  const { sessionId } = req.query

  if (!sessionId) {
    return res.status(400).json({
      code: 400,
      message: 'sessionId不能为空'
    })
  }

  const data = getSessionHistory(sessionId)

  if (!data) {
    return res.json({
      code: 200,
      message: 'success',
      data: {
        sessionId,
        history: [],
        summary: '',
        context: null,
        updatedAt: null
      }
    })
  }

  res.json({
    code: 200,
    message: 'success',
    data
  })
})

// ==============================
// 获取单个 Session 简介
// GET /session/preview?sessionId=xxx
// ==============================

router.get('/preview', (req, res) => {
  const { sessionId } = req.query

  if (!sessionId) {
    return res.status(400).json({
      code: 400,
      message: 'sessionId不能为空'
    })
  }

  const data = getSessionPreview(sessionId)

  if (!data) {
    return res.status(404).json({
      code: 404,
      message: 'Session不存在'
    })
  }

  res.json({
    code: 200,
    message: 'success',
    data
  })
})

// ==============================
// 获取所有历史 Session
// GET /session/list
// ==============================

router.get('/list', (req, res) => {
  const data = getAllSessionPreviews()

  res.json({
    code: 200,
    message: 'success',
    data
  })
})

// ==============================
// 清空当前 Session 历史
// DELETE /session/history?sessionId=xxx
// ==============================

router.delete('/history', (req, res) => {
  const { sessionId } = req.query

  if (!sessionId) {
    return res.status(400).json({
      code: 400,
      message: 'sessionId不能为空'
    })
  }

  const success = clearSessionHistory(sessionId)

  res.json({
    code: 200,
    message: success ? '历史记录已清空' : 'Session不存在'
  })
})

// ==============================
// 删除 Session
// DELETE /session/:sessionId
// ==============================

router.delete('/:sessionId', (req, res) => {
  const { sessionId } = req.params

  const success = deleteSession(sessionId)

  res.json({
    code: 200,
    message: success ? 'Session已删除' : 'Session不存在'
  })
})

export default router
