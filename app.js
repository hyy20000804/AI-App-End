// app.js

import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import os from 'os'

import deviceRouter from './routes/device.js'
import aiRouter from './routes/ai.js'
import sessionRouter from './routes/session.js'

const app = express()

// ==============================
// 基础中间件
// ==============================

app.use(cors())

app.use(
  express.json({
    limit: '1mb'
  })
)

// ==============================
// 路由
// ==============================

app.use('/device', deviceRouter)
app.use('/ai', aiRouter)
app.use('/ai/session', sessionRouter)

// ==============================
// 404
// ==============================

app.use((req, res) => {
  res.status(404).json({
    code: 404,
    message: '接口不存在'
  })
})

// ==============================
// 全局错误处理
// ==============================

app.use((error, req, res, next) => {
  console.error('[GLOBAL_ERROR]', error)

  if (res.headersSent) {
    return next(error)
  }

  res.status(500).json({
    code: 500,
    message: '服务器内部错误'
  })
})

// ==============================
// 获取本机局域网 IP
// ==============================

const getLocalIP = () => {
  const interfaces = os.networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (
        net.family === 'IPv4' &&
        !net.internal &&
        net.address.startsWith('192.168.')
      ) {
        return net.address
      }
    }
  }

  return 'localhost'
}

// ==============================
// 启动
// ==============================

const PORT = Number(process.env.PORT || 8091)
const localIP = getLocalIP()

app.listen(PORT, '0.0.0.0', () => {
  console.log('====================================')
  console.log('融天AI服务器启动成功')
  console.log(`Local:   http://localhost:${PORT}`)
  console.log(`Network: http://${localIP}:${PORT}`)
  console.log(`AI:      http://${localIP}:${PORT}/ai/chat`)
  console.log(`Device:  http://${localIP}:${PORT}/device`)
  console.log('====================================')
})
