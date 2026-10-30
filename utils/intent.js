// utils/intent.js

// ==============================
// 意图枚举
// ==============================

export const INTENTS = {
  DEVICE_COUNT: 'DEVICE_COUNT',
  DEVICE_LIST: 'DEVICE_LIST',
  DEVICE_STATUS: 'DEVICE_STATUS',
  DEVICE_ALARM: 'DEVICE_ALARM',
  DEVICE_RUN_STATUS: 'DEVICE_RUN_STATUS',
  AI_CHAT: 'AI_CHAT'
}

// ==============================
// 意图识别
// ==============================
//
// 顺序很重要：
//   1. 运行状态优先（否则被"设备状态"抢走）
//   2. 告警 / 异常（否则被"设备数量"抢走，如"有多少异常设备"）
//   3. 设备数量
//   4. 设备列表
//   5. 设备状态（MySQL 兜底）
//   6. 其他 → AI_CHAT
// ==============================

export function detectIntent (input) {
  const text = String(input || '').trim().toLowerCase()

  if (!text) return INTENTS.AI_CHAT

  // ==============================
  // 1. 运行状态（最高优先级）
  // ==============================

  if (
    /运行中|待机|停机|开机/.test(text) ||
    /哪些.*(运行|开着|启动)/.test(text) ||
    /设备.*(运行状态|运行情况)/.test(text)
  ) {
    return INTENTS.DEVICE_RUN_STATUS
  }

  // ==============================
  // 2. 告警 / 异常
  // ==============================

  if (/异常|故障|报警|告警|alarm/.test(text)) {
    return INTENTS.DEVICE_ALARM
  }

  // ==============================
  // 3. 设备数量
  // ==============================
  //
  // 覆盖常见表达：
  //   "有多少台设备"、"设备数量"、"一共多少设备"、
  //   "设备总数"、"多少台设备"、"总共有几台设备"
  // ==============================

  if (
    /多少(台|个)?设备/.test(text) ||
    /设备(数量|总数|数)/.test(text) ||
    /几台设备/.test(text) ||
    /一共.*设备/.test(text) ||
    /总共.*设备/.test(text) ||
    /设备.*多少/.test(text)
  ) {
    return INTENTS.DEVICE_COUNT
  }

  // ==============================
  // 4. 设备列表
  // ==============================
  //
  // 覆盖：
  //   "设备有哪些"、"设备列表"、"所有设备"、
  //   "设备一共有哪些"、"有哪些设备"
  // ==============================

  if (
    /设备(列表|清单)/.test(text) ||
    /有哪些设备/.test(text) ||
    /设备.*有哪些/.test(text) ||
    /设备.*哪些/.test(text) ||
    /所有设备/.test(text) ||
    /设备.*一览/.test(text)
  ) {
    return INTENTS.DEVICE_LIST
  }

  // ==============================
  // 5. 设备状态（MySQL 兜底）
  // ==============================

  if (/设备状态|状态分布|设备情况/.test(text)) {
    return INTENTS.DEVICE_STATUS
  }

  // ==============================
  // 6. 兜底 → AI 聊天
  // ==============================

  return INTENTS.AI_CHAT
}