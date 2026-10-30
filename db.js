import mysql from 'mysql2/promise'

export const db = mysql.createPool({
  host: '8.141.94.167',
  user: 'root',
  port: 3060,
  password: 'rongtian2025',
  database: 'device_system',

  // 连接池配置
  waitForConnections: true,
  connectionLimit: 10
})
