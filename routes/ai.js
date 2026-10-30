// routes/ai.js

import express from "express";
import { v4 as uuidv4 } from "uuid";

import { detectIntent, INTENTS } from "../utils/intent.js";

import {
  getAbnormalDevicesFromFault,
  getRunningDevicesFromOverview,
  getDeviceListFromFault,
  getDeviceStatus,
  getRelevantDevices,
  getDeviceFaultReasons,
  getEnergyData,
  getRecentEnergySummary, // ★ 新增
  isEnergyQuestion,
  todayStr,
  getLoadForecastData,
  isLoadForecastQuestion,
  parsePumpControlCommand,
  describeControlPoints,
  resolvePumpSystemDeviceId,
  controlDevice,
  fetchTodayStrategies,
  applyStrategyById,
  parseStrategyApplyIndex,
} from "../services/deviceService.js";
import {
  getSession,
  createSessionId,
  getRecentHistory,
  addHistory,
  updateSessionContext,
  generateSummary,
  getSessionHistory,
} from "../services/sessionService.js";

import { chatWithAI } from "../services/aiService.js";
import { logAIUsage } from "../utils/logger.js";

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;

let ENABLE_SESSION_CONTEXT = process.env.ENABLE_SESSION_CONTEXT !== "false";

// ==============================
// Token
// ==============================

function getAuthorizationToken(req) {
  const token = req.get("Authorization");

  if (typeof token !== "string" || !token.trim()) {
    return null;
  }

  return token.trim();
}

// ==============================
// 意图识别工具
// ==============================

function isFaultReasonQuestion(message = "") {
  return /为什么|为何|什么原因|原因是什么|怎么回事|故障原因|报警原因|告警原因|根因|怎么排查|排查原因|哪里坏了|什么故障|为什么异常|为什么报警|为什么故障/.test(
    String(message || ""),
  );
}

function isFaultOptimizeQuestion(message = "") {
  return /如何优化|怎么优化|怎样优化|如何处理|怎么处理|怎样处理|如何解决|怎么解决|怎样解决|如何改善|怎么改善|怎样改善|优化异常|处理异常|解决异常|排查异常|修复异常|处理方案|解决方案|优化方案|处理建议|解决建议|怎么修|如何修|怎么恢复|如何恢复/.test(
    String(message || ""),
  );
}

function isFaultAnalysisQuestion(message = "") {
  return isFaultReasonQuestion(message) || isFaultOptimizeQuestion(message);
}

function isFaultRelatedQuestion(message = "") {
  return /故障|报警|告警|异常|坏了|不工作|停机/.test(String(message || ""));
}

function isStrategyQueryQuestion(message = "") {
  const text = String(message || "");

  // 应用动词 → 不是查询
  if (/应用|执行|采用|采纳|启用|下发/.test(text)) return false;

  // 分析类语句不是查列表
  if (
    /分析|原因|为什么|为何|给出.*建议|给.*建议|提供.*建议|提.*建议|如何.*优化|怎么.*优化|如何降低|怎么降低|如何减少|怎么减少/.test(
      text,
    )
  ) {
    return false;
  }

  return /运行建议|优化建议|今日策略|今日建议|策略列表|建议列表|运行策略|优化策略/.test(
    text,
  );
}

function isStrategyApplyQuestion(message = "") {
  const text = String(message || "");

  const isQuestion = /[?？]|如何|怎么|怎样|是什么/.test(text);
  if (isQuestion) return false;

  const hasApplyVerb = /应用|执行|采用|采纳|启用|下发/.test(text);
  const hasStrategyTarget =
    /建议|策略|方案|第\s*[一二三四五六七八九十\d]+\s*条|这条|该条|上面|刚才|最新/.test(
      text,
    );

  return hasApplyVerb && hasStrategyTarget;
}

function isLoadAnalysisQuestion(message = "") {
  return /分析|原因|为什么|为何|建议|优化|如何降低|怎么降低|如何减少|怎么减少|节能|应对|如何调/.test(
    String(message || ""),
  );
}

function isEnergyAnalysisQuestion(message = "") {
  return /分析|原因|为什么|为何|建议|趋势|一周|本周|最近|过去|变化|上升|下降|节能|波动/.test(
    String(message || ""),
  );
}

// ★ 通用兜底联想：任何分支没有专属联想时都使用它
const DEFAULT_RELATED_QUESTIONS = [
  "今日能耗是多少？",
  "负荷趋势预测",
  "当前有哪些异常设备？",
  "今日运行建议",
];

// ==============================
// 格式化：今日运行建议列表（只展示前 5 条）
// ==============================

const STRATEGY_DISPLAY_LIMIT = 5;

function formatStrategyListAnswer(strategies) {
  const list = Array.isArray(strategies) ? strategies : [];

  if (!list.length) {
    return [
      "今日暂无运行建议。",
      "",
      "提示：可以稍后再试试，或询问「今日能耗」查看用能情况。",
    ].join("\n");
  }

  const total = list.length;
  const displayList = list.slice(0, STRATEGY_DISPLAY_LIMIT);
  const moreCount = total - displayList.length;

  const lines = [];

  if (moreCount > 0) {
    lines.push(
      `📋 今日共有 ${total} 条运行建议（仅展示前 ${STRATEGY_DISPLAY_LIMIT} 条）：`,
    );
  } else {
    lines.push(`📋 今日共有 ${total} 条运行建议：`);
  }

  lines.push("");

  displayList.forEach((s, idx) => {
    lines.push(`${idx + 1}. ${s.strategyDetail || "（无详情）"}`);

    const meta = [];
    if (s.energySavingRate > 0) {
      meta.push(`预计节能 ${s.energySavingRate.toFixed(1)}%`);
    }
    if (s.chwEff > 0) {
      meta.push(`能效 ${s.chwEff.toFixed(1)}`);
    }
    if (s.createTime) {
      meta.push(`生成于 ${s.createTime}`);
    }
    if (meta.length) {
      lines.push(`   📊 ${meta.join(" · ")}`);
    }
    lines.push("");
  });

  lines.push("提示：");
  lines.push("· 可以询问「应用第1条建议」执行对应策略");
  lines.push("· 也可以说「应用最新的建议」快速执行");

  if (moreCount > 0) {
    lines.push(`· 另有 ${moreCount} 条建议未展示，如需查看更多请稍后重新查询`);
  }

  return lines.join("\n");
}

// ==============================
// 格式化：故障回答
// ==============================

function formatFaultReasonAnswer(businessData) {
  const devices = Array.isArray(businessData?.devices)
    ? businessData.devices
    : [];

  if (!devices.length) {
    return businessData?.message || "当前没有查询到处于告警状态的设备。";
  }

  const blocks = devices.map((d) => {
    const lines = [];

    lines.push(`设备名称：${d.name || "未知设备"}`);

    if (d.faultReason) lines.push(`故障描述：${d.faultReason}`);
    if (d.alarmReason) lines.push(`报警原因：${d.alarmReason}`);
    if (d.normalizedFaultCode) lines.push(`故障编码：${d.normalizedFaultCode}`);

    return lines.join("\n");
  });

  const first = devices[0]?.name;
  const tips = [
    "提示：",
    first
      ? `· 可以继续询问「${first}如何优化异常」查看处理方案`
      : "· 可以继续询问「如何优化异常」查看处理方案",
    "· 可以询问其它异常设备的原因，例如「6号冷机为什么异常」",
  ];

  return [...blocks, "", ...tips].join("\n\n");
}

function formatFaultSolutionAnswer(businessData) {
  const devices = Array.isArray(businessData?.devices)
    ? businessData.devices
    : [];

  if (!devices.length) {
    return businessData?.message || "当前没有查询到处于告警状态的设备。";
  }

  const blocks = devices.map((d) => {
    const lines = [];

    lines.push(`设备名称：${d.name || "未知设备"}`);

    if (d.faultReason) lines.push(`故障描述：${d.faultReason}`);
    if (d.alarmReason) lines.push(`报警原因：${d.alarmReason}`);
    if (d.solution) lines.push(`解决方案：${d.solution}`);

    return lines.join("\n");
  });

  const tips = [
    "提示：",
    "· 可以查看全部异常设备，例如「当前有哪些异常设备」",
    "· 可以询问「今日能耗」或「负荷趋势预测」",
  ];

  return [...blocks, "", ...tips].join("\n\n");
}

// ==============================
// 格式化数字 / 能耗 / 负荷
// ==============================

function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

function formatEnergyAnswer(businessData) {
  if (!businessData) {
    return "暂时无法获取能耗数据，请稍后重试。";
  }

  const range = businessData.availableRange;
  const rangeTip = range ? `（可查询范围：${range.min} ~ ${range.max}）` : "";

  if (businessData.type === "energy_specific_date") {
    if (!businessData.inRange) {
      return [
        `${businessData.targetDate} 不在可查询范围内${rangeTip}。`,
        "",
        "提示：可以查询「今日能耗」「昨日能耗」或范围内其它日期。",
      ].join("\n");
    }

    return [
      `${businessData.targetDate} 的能耗：${formatNumber(
        businessData.targetValue,
      )} kWh`,
      "",
      "提示：可以查询具体其它日期的能耗，例如「2026-10-15的能耗」。",
    ].join("\n");
  }

  const today = businessData.today;
  const yesterday = businessData.yesterday;

  if (businessData.type === "energy_yesterday") {
    return [
      `昨日（${yesterday.date}）能耗：${formatNumber(yesterday.value)} kWh`,
      `今日（${today.date}）能耗：${formatNumber(today.value)} kWh`,
      `环比（今 vs 昨）：${businessData.diffPercent}（${businessData.diffDirection}）`,
      "",
      "提示：可以查询具体日期的能耗，例如「2026-10-15的能耗」。",
    ].join("\n");
  }

  return [
    `今日（${today.date}）能耗：${formatNumber(today.value)} kWh`,
    `昨日（${yesterday.date}）能耗：${formatNumber(yesterday.value)} kWh`,
    `环比昨日：${businessData.diffPercent}（${businessData.diffDirection}）`,
    "",
    "提示：可以查询具体日期的能耗，例如「2026-10-15的能耗」。",
  ].join("\n");
}

function formatLoadForecastAnswer(businessData) {
  if (!businessData) {
    return "暂时无法获取负荷预测数据，请稍后重试。";
  }

  if (!businessData.peak) {
    return businessData.message || "今日暂无负荷数据。";
  }

  const { peak, now, date } = businessData;

  const lines = [];

  lines.push(
    `预计 ${date} ${peak.time} 达到峰值 ${formatNumber(peak.value)} kW`,
  );

  if (now && now.value != null) {
    const cur = `当前负荷 ${formatNumber(now.value)} kW`;

    if (now.reality != null) {
      lines.push(`${cur}（实际 ${formatNumber(now.reality)} kW）`);
    } else {
      lines.push(cur);
    }
  }

  const weatherParts = [];
  if (peak.temp != null) weatherParts.push(`温度 ${peak.temp}℃`);
  if (peak.humidity != null) weatherParts.push(`湿度 ${peak.humidity}%`);
  if (peak.text) weatherParts.push(peak.text);

  if (weatherParts.length) {
    lines.push("");
    lines.push(`参考：峰值时刻 ${weatherParts.join("、")}`);
  }

  lines.push("");
  lines.push("提示：可以进一步询问「为什么出现峰值」或「如何降低峰值负荷」。");

  return lines.join("\n");
}

// ==============================
// Java 错误 / 参数构造
// ==============================

function sendDataError(res, requestId, error, fallbackMessage) {
  const status = [401, 403, 502, 504].includes(error?.status)
    ? error.status
    : 502;

  const message =
    status === 401
      ? "登录凭证无效或已过期，请重新登录"
      : status === 403
        ? "当前用户没有权限访问该数据"
        : status === 504
          ? "业务接口响应超时，请稍后重试"
          : fallbackMessage;

  return res.status(status).json({
    code: status,
    requestId,
    message,
  });
}

function buildFaultParams(req) {
  const orgId = req.user?.orgId || req.body?.orgId || req.query?.orgId || null;

  const date =
    req.body?.date || req.query?.date || new Date().toISOString().slice(0, 10);

  const params = {
    date,
    token: getAuthorizationToken(req),
  };

  if (orgId) params.orgId = orgId;

  return params;
}

function buildOverviewParams(req) {
  const orgId = req.user?.orgId || req.body?.orgId || req.query?.orgId || null;

  const type = req.body?.type || req.query?.type || 1;

  const params = {
    type,
    token: getAuthorizationToken(req),
  };

  if (orgId) params.orgId = orgId;

  return params;
}

// ==============================
// Session 辅助
// ==============================

function getRequestSession(req) {
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";

  const currentSessionId = sessionId || createSessionId();

  const session = ENABLE_SESSION_CONTEXT ? getSession(currentSessionId) : null;

  return {
    currentSessionId,
    session,
  };
}

// ============================================================
// ★ 从 answer 末尾剥离 "提示：\n· ..." 块
//   并把块里出现的「...」内容收集成候选联想
// ============================================================
function stripTipBlock(answer) {
  if (typeof answer !== "string" || !answer) {
    return { body: answer, tipSuggestions: [] };
  }

  // 只匹配"提示："+"多行 ·/- 列表"且位于回答末尾
  const re = /\n+\s*提示\s*[:：]\s*\n((?:[·•\-*].*(?:\n|$))+)/;
  const m = answer.match(re);

  if (!m || m.index === undefined) {
    return { body: answer, tipSuggestions: [] };
  }

  // 该块后面若还有正文（例如 "提示：" 出现在中间），不剥离
  const blockEnd = m.index + m[0].length;
  if (answer.slice(blockEnd).trim()) {
    return { body: answer, tipSuggestions: [] };
  }

  const body = answer.slice(0, m.index).trimEnd();
  const block = m[1] || "";

  // 从块里的「...」提取候选词
  const tipSuggestions = [];
  const quotedRe = /「([^」]+)」/g;
  let qm;
  while ((qm = quotedRe.exec(block)) !== null) {
    const v = qm[1].trim();
    if (v && !tipSuggestions.includes(v)) tipSuggestions.push(v);
  }

  return { body, tipSuggestions };
}

// ============================================================
// ★ 统一出口：
//   1) 剥离 answer 里的 "提示：· ..." 块（不往正文里塞）
//   2) 该块里的「...」→ 合并进 relatedQuestions
//   3) relatedQuestions 不足时用 DEFAULT_RELATED_QUESTIONS 补足
//   4) 不再拼 "💡 你可能还想问：" 到 answer 里
// ============================================================
function sendAnswer(
  res,
  {
    requestId,
    currentSessionId,
    answer,
    intent,
    relatedQuestions,
    details,
    usage,
  },
) {
  const { body, tipSuggestions } = stripTipBlock(answer);

  // 合并去重（顺序：分支专属 → 从"提示："块提取 → DEFAULT 补足）
  const merged = [];
  const push = (v) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!s) return;
    if (!merged.includes(s)) merged.push(s);
  };

  if (Array.isArray(relatedQuestions)) relatedQuestions.forEach(push);
  tipSuggestions.forEach(push);
  DEFAULT_RELATED_QUESTIONS.forEach(push);

  // 上限 6 条，避免一条气泡塞太多
  const finalRelated = merged.slice(0, 6);

  const payload = {
    code: 200,
    requestId,
    sessionId: currentSessionId,
    answer: body, // ★ 正文不再包含 "提示：" 与 "💡 你可能还想问："
    intent,
    enableSessionCache: ENABLE_SESSION_CONTEXT,
    relatedQuestions: finalRelated,
  };

  if (details !== undefined) payload.details = details;
  if (usage !== undefined) payload.usage = usage;

  return res.json(payload);
}

// ==============================
// GET /ai/cache-toggle
// ==============================

router.get("/cache-toggle", (req, res) => {
  const { enable } = req.query;

  if (enable !== undefined) {
    ENABLE_SESSION_CONTEXT = enable === "true";

    console.log(`[AI_CONTEXT] ${ENABLE_SESSION_CONTEXT ? "开启" : "关闭"}`);
  }

  return res.json({
    code: 200,
    enableSessionCache: ENABLE_SESSION_CONTEXT,
    desc: ENABLE_SESSION_CONTEXT
      ? "上下文开启，会携带历史对话"
      : "上下文关闭，每次请求独立对话",
  });
});

// ==============================
// POST /ai/chat
// ==============================

router.post("/chat", async (req, res) => {
  const requestId = uuidv4();
  const requestStart = Date.now();

  try {
    const { message } = req.body || {};

    // 1. 校验消息
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        code: 400,
        requestId,
        message: "message不能为空",
      });
    }

    const userMessage = message.trim();

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        code: 400,
        requestId,
        message: `消息长度不能超过${MAX_MESSAGE_LENGTH}字`,
      });
    }

    // 2. Token
    const token = getAuthorizationToken(req);

    if (!token) {
      return res.status(401).json({
        code: 401,
        requestId,
        message: "登录凭证缺失，请重新登录",
      });
    }

    // 3. Session / Intent
    const { currentSessionId, session } = getRequestSession(req);
    const intent = detectIntent(userMessage);

    console.log("[AI_REQUEST]", {
      requestId,
      sessionId: currentSessionId,
      intent,
      context: ENABLE_SESSION_CONTEXT,
    });

    // ==========================
    // 冷冻泵控制
    // ==========================

    const controlCmd = parsePumpControlCommand(userMessage);

    if (controlCmd) {
      const CONTROL_INTENT = "DEVICE_CONTROL";

      console.log("[CONTROL_INTENT]", { requestId, cmd: controlCmd });

      const orgId =
        req.user?.orgId || req.body?.orgId || req.query?.orgId || null;

      if (!orgId) {
        const answer = "缺少园区信息，无法下发控制指令。";
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      if (!controlCmd.pumpNum && !controlCmd.isAll) {
        const answer = [
          "请指定要控制哪台冷冻泵，例如：",
          "· 「启动1号冷冻泵」",
          "· 「关闭2号冷冻泵」",
          "· 「把3号冷冻泵频率调到45Hz」",
        ].join("\n");

        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      if (
        controlCmd.freq !== null &&
        !(controlCmd.freq >= 0 && controlCmd.freq <= 60)
      ) {
        const answer = "频率需在 0~60Hz 之间，请重新输入。";
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      const pumpNumbers = controlCmd.isAll ? [1, 2, 3] : [controlCmd.pumpNum];

      for (const n of pumpNumbers) {
        if (!Number.isInteger(n) || n < 1 || n > 3) {
          const answer = `泵编号 ${n} 无效，只支持 1~3 号冷冻泵。`;
          if (session) addHistory(session, userMessage, answer);

          return sendAnswer(res, {
            requestId,
            currentSessionId,
            answer,
            intent: CONTROL_INTENT,
          });
        }
      }

      const pointValues = {};

      if (controlCmd.mode !== null) {
        pointValues.PumpControlMode = controlCmd.mode;
      }

      if (controlCmd.wantsStart) {
        for (const n of pumpNumbers) pointValues[`SSC${n}`] = "1";
        if (controlCmd.mode === null) pointValues.PumpControlMode = "0";
      } else if (controlCmd.wantsStop) {
        for (const n of pumpNumbers) pointValues[`SSC${n}`] = "0";
      }

      if (controlCmd.freq !== null) {
        for (const n of pumpNumbers)
          pointValues[`FreqSet${n}`] = String(controlCmd.freq);
      }

      if (Object.keys(pointValues).length === 0) {
        const answer = "未能识别到有效控制动作，请说明操作。";
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      let deviceId;
      try {
        deviceId = await resolvePumpSystemDeviceId({ token, orgId, type: 1 });
      } catch (error) {
        console.error("[CONTROL_RESOLVE_ID_ERROR]", {
          requestId,
          message: error?.message,
        });

        const answer = `查询冷冻泵系统失败：${error.message || "请稍后重试"}`;
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      if (!deviceId) {
        const answer = "未找到冷冻泵系统设备，无法下发控制指令。";
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      try {
        await controlDevice({ deviceId, orgId, type: 1, pointValues, token });
      } catch (error) {
        console.error("[AI_CONTROL_ERROR]", {
          requestId,
          message: error?.message,
        });

        const answer = `控制指令下发失败：${error.message || "请稍后重试"}`;
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: CONTROL_INTENT,
        });
      }

      const summary = describeControlPoints(pointValues);
      const answer = [
        "✅ 控制指令已下发成功",
        "",
        `操作内容：${summary}`,
        "",
        "提示：设备状态可能延迟几秒更新，可稍后询问「1号冷冻泵运行状态」确认。",
      ].join("\n");

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent: CONTROL_INTENT,
          lastControl: { pointValues, deviceId },
        });
      }

      console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent: CONTROL_INTENT,
      });
    }

    // ==========================
    // 应用运行建议
    // ==========================

    if (isStrategyApplyQuestion(userMessage)) {
      const STRATEGY_APPLY_INTENT = "STRATEGY_APPLY";

      console.log("[STRATEGY_APPLY_INTENT]", {
        requestId,
        message: userMessage,
      });

      const orgId =
        req.user?.orgId || req.body?.orgId || req.query?.orgId || null;

      if (!orgId) {
        const answer = "缺少园区信息，无法应用运行建议。";
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: STRATEGY_APPLY_INTENT,
        });
      }

      const { index } = parseStrategyApplyIndex(userMessage);

      let target = null;
      let allStrategies = [];

      const cached = session?.context?.lastStrategies;
      if (Array.isArray(cached) && cached.length > 0) {
        allStrategies = cached;
        const idx = (index || 1) - 1;
        if (idx >= 0 && idx < cached.length) target = cached[idx];
      }

      if (!target) {
        try {
          allStrategies = await fetchTodayStrategies({ token, orgId, type: 1 });
          allStrategies = allStrategies.slice(0, STRATEGY_DISPLAY_LIMIT);
        } catch (error) {
          console.error("[STRATEGY_FETCH_ERROR]", {
            requestId,
            message: error?.message,
          });

          const answer = `获取运行建议失败：${error.message || "请稍后重试"}`;
          if (session) addHistory(session, userMessage, answer);

          return sendAnswer(res, {
            requestId,
            currentSessionId,
            answer,
            intent: STRATEGY_APPLY_INTENT,
          });
        }

        const idx = (index || 1) - 1;
        if (idx >= 0 && idx < allStrategies.length) target = allStrategies[idx];
      }

      if (!target) {
        const answer = [
          `未能找到第 ${index || 1} 条运行建议。`,
          "",
          "提示：可以询问「今日运行建议」查看当前可应用的策略。",
        ].join("\n");

        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: STRATEGY_APPLY_INTENT,
        });
      }

      try {
        await applyStrategyById({ id: target.id, orgId, type: 1, token });
      } catch (error) {
        console.error("[STRATEGY_APPLY_ERROR]", {
          requestId,
          message: error?.message,
        });

        const answer = `应用运行建议失败：${error.message || "请稍后重试"}`;
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: STRATEGY_APPLY_INTENT,
        });
      }

      const answer = [
        "✅ 运行建议已应用",
        "",
        `策略内容：${target.strategyDetail || "（无详情）"}`,
        target.createTime ? `生成时间：${target.createTime}` : "",
        target.energySavingRate > 0
          ? `预计节能：${target.energySavingRate.toFixed(1)}%`
          : "",
        "",
        "提示：设备侧实际执行可能有几秒到几分钟延迟，可稍后询问「1号冷冻泵运行状态」确认。",
      ]
        .filter(Boolean)
        .join("\n");

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent: STRATEGY_APPLY_INTENT,
          lastAppliedStrategy: target,
        });
      }

      console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent: STRATEGY_APPLY_INTENT,
      });
    }

    // ==========================
    // 查询运行建议
    // ==========================

    if (isStrategyQueryQuestion(userMessage)) {
      const STRATEGY_QUERY_INTENT = "STRATEGY_QUERY";

      console.log("[STRATEGY_QUERY_INTENT]", {
        requestId,
        message: userMessage,
      });

      const orgId =
        req.user?.orgId || req.body?.orgId || req.query?.orgId || null;

      if (!orgId) {
        const answer = "缺少园区信息，无法查询运行建议。";
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: STRATEGY_QUERY_INTENT,
        });
      }

      let strategies = [];
      try {
        strategies = await fetchTodayStrategies({ token, orgId, type: 1 });
      } catch (error) {
        console.error("[STRATEGY_QUERY_ERROR]", {
          requestId,
          message: error?.message,
        });

        const answer = `获取运行建议失败：${error.message || "请稍后重试"}`;
        if (session) addHistory(session, userMessage, answer);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent: STRATEGY_QUERY_INTENT,
        });
      }

      const answer = formatStrategyListAnswer(strategies);

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent: STRATEGY_QUERY_INTENT,
          lastStrategies: strategies.slice(0, STRATEGY_DISPLAY_LIMIT),
        });
      }

      console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent: STRATEGY_QUERY_INTENT,
      });
    }

    // ==========================
    // 设备数量
    // ==========================

    if (intent === INTENTS.DEVICE_COUNT) {
      let devices;

      try {
        devices = await getDeviceListFromFault(buildFaultParams(req));
      } catch (error) {
        console.error("[DEVICE_COUNT_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "设备数量查询失败，请稍后重试",
        );
      }

      const answer = `当前园区共有 ${devices.length} 台设备。`;

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, { intent });
      }

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
      });
    }

    // ==========================
    // 能耗：分析 / 查询
    // ★ 关键改动 1：内部分流
    // ==========================

    if (isEnergyQuestion(userMessage)) {
      const orgId =
        req.user?.orgId || req.body?.orgId || req.query?.orgId || null;

      // ---------- 能耗分析（分析/原因/趋势/一周/节能建议 等） ----------
      if (isEnergyAnalysisQuestion(userMessage)) {
        console.log("[ENERGY_ANALYSIS_INTENT]", {
          requestId,
          message: userMessage,
        });

        let energySummary;
        try {
          energySummary = await getRecentEnergySummary(userMessage, {
            ...buildOverviewParams(req),
          });
        } catch (error) {
          console.error("[ENERGY_ANALYSIS_ERROR]", error.message);

          return sendDataError(
            res,
            requestId,
            error,
            "能耗分析数据获取失败，请稍后重试",
          );
        }

        const businessData = energySummary;

        const history =
          ENABLE_SESSION_CONTEXT && session ? getRecentHistory(session) : [];
        const summary =
          ENABLE_SESSION_CONTEXT && session ? session.summary : "";
        const context =
          ENABLE_SESSION_CONTEXT && session ? session.context : {};

        const result = await chatWithAI({
          message: userMessage,
          history,
          summary,
          businessData,
          context,
        });

        const answer = result.answer;

        if (session) {
          addHistory(session, userMessage, answer);
          updateSessionContext(session, {
            intent,
            energy: energySummary,
          });
          if (session.history.length >= 24) {
            await generateSummary(session);
          }
        }

        logAIUsage({
          requestId,
          sessionId: currentSessionId,
          intent,
          historyRounds: history.length / 2,
          hasSummary: Boolean(summary),
          response: { usage: result.usage },
          duration: result.duration,
        });

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent,
          details: {
            type: "energy_analysis",
            today: energySummary.today,
            yesterday: energySummary.yesterday,
            diffPercent: energySummary.diffPercent,
            diffDirection: energySummary.diffDirection,
            week: energySummary.week,
            availableRange: energySummary.availableRange,
          },
          relatedQuestions: [
            "今天能耗比一周均值高还是低？",
            "本周哪天能耗最高/最低？为什么？",
            "对比昨日，能耗下降的主要贡献是什么？",
            "有哪些可以立即执行的节能措施？",
          ],
          usage:
            process.env.NODE_ENV === "development" ? result.usage : undefined,
        });
      }

      // ---------- 能耗简单查询（今日 / 昨日 / 具体日期） ----------
      let energyData;

      try {
        energyData = await getEnergyData(userMessage, {
          ...buildOverviewParams(req),
          date: todayStr(),
        });
      } catch (error) {
        console.error("[ENERGY_QUERY_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "能耗数据获取失败，请稍后重试",
        );
      }

      const answer = formatEnergyAnswer(energyData);

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent,
          energy: energyData,
        });
      }

      console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
      });
    }

    // ==========================
    // 负荷分析
    // ★ 关键改动 2：放在"负荷预测直接返回"之前
    // ==========================

    if (
      isLoadForecastQuestion(userMessage) &&
      isLoadAnalysisQuestion(userMessage)
    ) {
      console.log("[LOAD_ANALYSIS_INTENT]", {
        requestId,
        message: userMessage,
      });

      let forecastData;
      try {
        forecastData = await getLoadForecastData(userMessage, {
          ...buildOverviewParams(req),
        });
      } catch (error) {
        console.error("[LOAD_ANALYSIS_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "负荷分析数据获取失败，请稍后重试",
        );
      }

      const businessData = forecastData;

      const history =
        ENABLE_SESSION_CONTEXT && session ? getRecentHistory(session) : [];
      const summary = ENABLE_SESSION_CONTEXT && session ? session.summary : "";
      const context = ENABLE_SESSION_CONTEXT && session ? session.context : {};

      const result = await chatWithAI({
        message: userMessage,
        history,
        summary,
        businessData,
        context,
      });

      const answer = result.answer;

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent,
          loadForecast: forecastData,
        });
        if (session.history.length >= 24) {
          await generateSummary(session);
        }
      }

      logAIUsage({
        requestId,
        sessionId: currentSessionId,
        intent,
        historyRounds: history.length / 2,
        hasSummary: Boolean(summary),
        response: { usage: result.usage },
        duration: result.duration,
      });

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
        details: forecastData,
        relatedQuestions: [
          "为什么峰值出现在这个时段？",
          "如何降低峰值负荷？",
          "今天的实际负荷与预测偏差大吗？",
          "对比历史同期峰值情况",
        ],
        usage:
          process.env.NODE_ENV === "development" ? result.usage : undefined,
      });
    }

    // ==========================
    // 负荷预测直接返回（简单查询）
    // ==========================

    if (
      isLoadForecastQuestion(userMessage) &&
      !isFaultReasonQuestion(userMessage) &&
      !isFaultOptimizeQuestion(userMessage)
    ) {
      let forecastData;

      try {
        forecastData = await getLoadForecastData(userMessage, {
          ...buildOverviewParams(req),
        });
      } catch (error) {
        console.error("[LOAD_FORECAST_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "负荷预测数据获取失败，请稍后重试",
        );
      }

      const answer = formatLoadForecastAnswer(forecastData);

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent,
          loadForecast: forecastData,
        });
      }

      console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
      });
    }

    // ==========================
    // 故障原因 / 优化处理
    // ==========================

    const asksReason = isFaultReasonQuestion(userMessage);
    const asksOptimize = isFaultOptimizeQuestion(userMessage);
    const asksFault = isFaultRelatedQuestion(userMessage);

    if ((asksReason || asksOptimize) && asksFault) {
      let businessData;

      try {
        businessData = await getDeviceFaultReasons(
          userMessage,
          buildFaultParams(req),
        );
      } catch (error) {
        console.error("[DEVICE_FAULT_ANALYSIS_ERROR]", {
          requestId,
          error: error?.message,
        });

        return sendDataError(
          res,
          requestId,
          error,
          "设备故障分析数据获取失败，请稍后重试",
        );
      }

      if (asksReason && !asksOptimize) {
        const answer = formatFaultReasonAnswer(businessData);

        if (session) {
          addHistory(session, userMessage, answer);
          updateSessionContext(session, {
            intent,
            device: businessData?.devices?.[0] || null,
            faultAnalysis: businessData,
          });
        }

        console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent,
        });
      }

      if (asksOptimize && !asksReason) {
        const answer = formatFaultSolutionAnswer(businessData);

        if (session) {
          addHistory(session, userMessage, answer);
          updateSessionContext(session, {
            intent,
            device: businessData?.devices?.[0] || null,
            faultAnalysis: businessData,
          });
        }

        console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

        return sendAnswer(res, {
          requestId,
          currentSessionId,
          answer,
          intent,
        });
      }

      // 两类都命中 → AI 综合
      const history =
        ENABLE_SESSION_CONTEXT && session ? getRecentHistory(session) : [];
      const summary = ENABLE_SESSION_CONTEXT && session ? session.summary : "";
      const context = ENABLE_SESSION_CONTEXT && session ? session.context : {};

      const result = await chatWithAI({
        message: userMessage,
        history,
        summary,
        businessData,
        context,
      });

      const answer = result.answer;

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, {
          intent,
          device: businessData?.devices?.[0] || null,
          faultAnalysis: businessData,
        });
        if (session.history.length >= 24) {
          await generateSummary(session);
        }
      }

      logAIUsage({
        requestId,
        sessionId: currentSessionId,
        intent,
        historyRounds: history.length / 2,
        hasSummary: Boolean(summary),
        response: { usage: result.usage },
        duration: result.duration,
      });

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
        details: businessData,
        relatedQuestions: [
          "当前还有哪些异常设备？",
          "这些设备应该如何预防类似故障？",
          "今日能耗情况如何？",
          "今日运行建议",
        ],
        usage:
          process.env.NODE_ENV === "development" ? result.usage : undefined,
      });
    }

    // ==========================
    // 异常设备列表
    // ==========================

    if (intent === INTENTS.DEVICE_ALARM) {
      let devices;

      try {
        devices = await getAbnormalDevicesFromFault(buildFaultParams(req));
      } catch (error) {
        console.error("[DEVICE_ALARM_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "设备告警数据获取失败，请稍后重试",
        );
      }

      let answer;

      if (devices.length) {
        answer = [
          `当前异常设备共 ${devices.length} 台：`,
          "",
          ...devices.map((item) => `- ${item.name}：${item.level || "异常"}`),
          "",
          "提示：",
          "· 可以询问具体设备的原因，例如「5号冷机为什么异常」",
          "· 可以询问处理方式，例如「5号冷机如何优化异常」",
        ].join("\n");
      } else {
        answer = [
          "当前没有发现异常设备。",
          "",
          "提示：",
          "· 可以询问「今日能耗」查看用能情况",
          "· 可以询问「负荷趋势预测」查看峰值时段",
        ].join("\n");
      }

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, { intent, device: devices[0] || null });
      }

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
      });
    }

    // ==========================
    // 设备列表
    // ==========================

    if (intent === INTENTS.DEVICE_LIST) {
      let devices;

      try {
        devices = await getDeviceListFromFault(buildFaultParams(req));
      } catch (error) {
        console.error("[DEVICE_LIST_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "设备列表获取失败，请稍后重试",
        );
      }

      const answer = devices.length
        ? [
            `当前园区共 ${devices.length} 台设备：`,
            "",
            ...devices.map((device) => {
              const status = device.runStatus || device.level || "状态未知";
              return `- ${device.name}：${status}`;
            }),
          ].join("\n")
        : "当前没有查询到设备。";

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, { intent });
      }

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
      });
    }

    // ==========================
    // 设备状态统计
    // ==========================

    if (intent === INTENTS.DEVICE_STATUS) {
      const statusList = await getDeviceStatus();

      const answer = statusList.length
        ? [
            "当前设备状态（数据库统计）：",
            "",
            ...statusList.map((item) => `${item.status}：${item.count} 台`),
          ].join("\n")
        : "暂无设备状态数据。";

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, { intent });
      }

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
      });
    }

    // ==========================
    // 设备运行状态
    // ==========================

    if (intent === INTENTS.DEVICE_RUN_STATUS) {
      let devices;

      try {
        devices = await getRunningDevicesFromOverview(buildOverviewParams(req));
      } catch (error) {
        console.error("[RUN_STATUS_ERROR]", error.message);

        return sendDataError(
          res,
          requestId,
          error,
          "设备运行状态获取失败，请稍后重试",
        );
      }

      const running = devices.filter((d) => d.isRunning === true);
      const standby = devices.filter((d) => d.isRunning === false);
      const unknown = devices.filter((d) => d.isRunning === null);

      let answer;

      if (!devices.length) {
        answer = "当前没有查询到设备。";
      } else {
        const lines = [
          `当前园区共查询到 ${devices.length} 台设备（冷机 + 冷冻泵）。`,
          `运行中 ${running.length} 台，待机 ${standby.length} 台，状态未知 ${unknown.length} 台。`,
        ];

        if (running.length) {
          lines.push("", "运行中的设备：");
          for (const device of running) {
            const parts = [];
            if (device.power !== null)
              parts.push(`功率 ${device.power}${device.powerUnit}`);
            if (device.deviceType === "Unit" && device.load !== null) {
              parts.push(`负载 ${device.load}%`);
            } else if (
              device.deviceType === "FirstCoolingPump" &&
              device.freq !== null
            ) {
              parts.push(`频率 ${device.freq}Hz`);
            }
            lines.push(
              `- ${device.name}${parts.length ? `（${parts.join("，")}）` : ""}`,
            );
          }
        }

        if (unknown.length) {
          lines.push("", "状态未知的设备：");
          for (const device of unknown) lines.push(`- ${device.name}`);
        }

        answer = lines.join("\n");
      }

      // ★ 正文末尾追加"可以通过 AI 控制冷冻泵"的提示
      answer = [
        answer,
        "",
        "💡 也可以通过 AI 直接控制冷冻泵，例如说「开启手动模式并开启1号冷冻泵」。",
      ].join("\n");

      if (session) {
        addHistory(session, userMessage, answer);
        updateSessionContext(session, { intent, device: devices[0] || null });
      }

      return sendAnswer(res, {
        requestId,
        currentSessionId,
        answer,
        intent,
        // ★ 联想：第一条即"开启手动模式并开启1号冷冻泵"
        relatedQuestions: [
          "开启手动模式并开启1号冷冻泵",
          "启动2号冷冻泵",
          "关闭1号冷冻泵",
          "把3号冷冻泵频率调到45Hz",
        ],
      });
    }

    // ==========================
    // AI 分析 / 普通聊天
    // ==========================

    const businessData = await getRelevantDevices(
      userMessage,
      buildOverviewParams(req),
    );

    const history =
      ENABLE_SESSION_CONTEXT && session ? getRecentHistory(session) : [];
    const summary = ENABLE_SESSION_CONTEXT && session ? session.summary : "";
    const context = ENABLE_SESSION_CONTEXT && session ? session.context : {};

    const result = await chatWithAI({
      message: userMessage,
      history,
      summary,
      businessData,
      context,
    });

    const answer = result.answer;

    if (session) {
      addHistory(session, userMessage, answer);
      updateSessionContext(session, {
        intent,
        device: businessData?.[0] || null,
      });
      if (session.history.length >= 24) {
        await generateSummary(session);
      }
    }

    logAIUsage({
      requestId,
      sessionId: currentSessionId,
      intent,
      historyRounds: history.length / 2,
      hasSummary: Boolean(summary),
      response: { usage: result.usage },
      duration: result.duration,
    });

    console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);

    return sendAnswer(res, {
      requestId,
      currentSessionId,
      answer,
      intent,
      // 不传 relatedQuestions，sendAnswer 会用 DEFAULT_RELATED_QUESTIONS 兜底
      usage: process.env.NODE_ENV === "development" ? result.usage : undefined,
    });

    console.log(`[AI_SUCCESS] ${requestId} ${Date.now() - requestStart}ms`);
  } catch (error) {
    console.error("[AI_ERROR]", {
      requestId,
      status: error?.status,
      error: error?.message,
    });

    if (error?.isJavaError) {
      return sendDataError(
        res,
        requestId,
        error,
        "业务数据获取失败，请稍后重试",
      );
    }

    if (error?.name === "APIConnectionTimeoutError") {
      return res.status(504).json({
        code: 504,
        requestId,
        message: "AI 服务响应超时，请稍后重试",
      });
    }

    if (error?.name === "APIConnectionError") {
      return res.status(502).json({
        code: 502,
        requestId,
        message: "AI 服务暂时不可用，请稍后重试",
      });
    }

    return res.status(500).json({
      code: 500,
      requestId,
      message: "AI 调用失败，请稍后重试",
    });
  }
});

// ==============================
// 获取对话历史
// ==============================

router.get("/history/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        code: 400,
        message: "sessionId不能为空",
      });
    }

    const result = getSessionHistory(sessionId);

    return res.json({ code: 200, ...result });
  } catch (error) {
    console.error("[AI_HISTORY_ERROR]", error.message);

    return res.status(500).json({
      code: 500,
      message: "获取对话历史失败",
    });
  }
});

export default router;
