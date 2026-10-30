// services/deviceService.js

import { db } from "../db.js";
import { javaClient } from "../routes/javaProxy.js";
import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ============================================================
// 设备类型 code → 中文映射
// ============================================================

const DEVICE_TYPE_MAP = {
  FirstCoolingPump: "冷冻泵",
  SecondCoolingPump: "冷却泵",
  Unit: "冷机",
  UnitSystem: "冷机系统",
  Chiller: "冷机",
  Fan: "风机",
  AHU: "空调箱",
  Camera: "摄像头",
  AccessControl: "门禁",
  FirstCoolingPumpSystem: "冷冻泵系统",
  Electricity: "电表",
  System: "系统",
  HeaderTank: "集水器",
  Distributor: "分水器",
};

// ============================================================
// 日期工具
// ============================================================

export function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr() {
  return formatDate(new Date());
}

export function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

// 从问题里解析具体日期
// 支持：
//   2026-10-15
//   2026/10/15
//   10月15日 / 10月15号
//   10-15（不带年份，默认当年）
function parseDateFromMessage(message) {
  const text = String(message || "");

  // 2026-10-15 / 2026/10/15
  let m = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  // 10月15日 / 10月15号
  m = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (m) {
    const now = new Date();
    const y = now.getFullYear();
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  // 10-15（不带年份）
  m = text.match(/\b(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const now = new Date();
    const y = now.getFullYear();
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Excel 故障码知识库
//
// fault.xlsx 表头（实际）：
//   故障代码(Alarm_Code) | 故障描述 | 报警原因 | 控制系统动作 | 复位类型 | 解决方案
//
// 兼容写法（脚本自动识别）：
//   "Alarm_Code" / "Alarm Code" / "故障代码" / "故障码" / "故障代码(Alarm_Code)" ...
//
// Java AlarmASCII1 可能返回：
//   05#SW753
// 匹配 key：
//   SW753
// ============================================================

let faultCodeMap = new Map();

// ------------------------------------------------------------
// 判断一个表头 key 是否是"故障码"列
// ------------------------------------------------------------
function isAlarmCodeKey(key) {
  const k = String(key ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");

  if (!k) return false;

  return (
    k.includes("alarm_code") ||
    k.includes("alarmcode") ||
    k.includes("故障代码") ||
    k.includes("故障码") ||
    k === "code"
  );
}

// ------------------------------------------------------------
// 从一行对象里，模糊取某个语义列的值
// ------------------------------------------------------------
function pickColumn(row, keys) {
  const normalizedKeys = keys.map((k) =>
    String(k).toLowerCase().replace(/\s+/g, ""),
  );

  for (const [rawKey, value] of Object.entries(row)) {
    const k = String(rawKey ?? "")
      .toLowerCase()
      .replace(/\s+/g, "");

    if (normalizedKeys.some((want) => k.includes(want))) {
      const v = String(value ?? "").trim();
      if (v) return v;
    }
  }

  return "";
}

// ------------------------------------------------------------
// 标准化故障码：
//   "05#SW753" → "SW753"
//   "1#CM000"  → "CM000"
//   "cm000"    → "CM000"
// ------------------------------------------------------------
function normalizeFaultCode(code) {
  if (code === null || code === undefined) return "";

  let value = String(code).trim().toUpperCase();
  if (!value) return "";

  const hashIndex = value.lastIndexOf("#");
  if (hashIndex >= 0) {
    value = value.slice(hashIndex + 1).trim();
  }

  return value;
}

// ------------------------------------------------------------
// 判断这一行的故障描述列是否为空（用于跳过后面的空白行）
// ------------------------------------------------------------
function isEmptyFaultRow(row) {
  const code = pickColumn(row, [
    "Alarm_Code",
    "Alarm Code",
    "故障代码",
    "故障码",
  ]);
  const desc = pickColumn(row, ["故障描述"]);
  return !code && !desc;
}

// ------------------------------------------------------------
// 加载 fault.xlsx
// ------------------------------------------------------------
function loadFaultCodeMap() {
  try {
    const filePath = path.resolve(__dirname, "../fault.xlsx");

    console.log("[FaultCode] Excel绝对路径:", filePath);
    console.log("[FaultCode] 文件是否存在:", fs.existsSync(filePath));

    if (!fs.existsSync(filePath)) {
      console.warn(`[FaultCode] 未找到故障码文件：${filePath}`);
      return new Map();
    }

    const workbook = XLSX.readFile(filePath);

    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) {
      console.warn("[FaultCode] fault.xlsx 没有工作表");
      return new Map();
    }

    const sheet = workbook.Sheets[sheetName];

    // 1) 原始二维数据（用于日志排查）
    const rawRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });

    console.log("[FaultCode] 原始数据行数:", rawRows.length);

    // 2) 按表头读成对象
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
    });

    console.log(
      "[FaultCode] 实际表头:",
      rows.length ? Object.keys(rows[0]) : [],
    );

    const map = new Map();

    // 用于"同上"语义：上一行的值
    let prevFaultDescription = null;
    let prevAlarmReason = null;
    let prevControlAction = null;
    let prevResetType = null;
    let prevSolution = null;

    for (const row of rows) {
      // 表头去除首尾空格
      const normalizedRow = {};
      for (const [key, value] of Object.entries(row)) {
        normalizedRow[String(key).trim()] = value;
      }

      // 跳过后面全空的行
      if (isEmptyFaultRow(normalizedRow)) continue;

      // ----------------------------------------------
      // ★ 模糊匹配故障码列（兼容 "故障代码(Alarm_Code)"）
      // ----------------------------------------------
      let rawCode = "";
      for (const [key, value] of Object.entries(normalizedRow)) {
        if (isAlarmCodeKey(key)) {
          const v = String(value ?? "").trim();
          if (v) {
            rawCode = v;
            break;
          }
        }
      }

      const code = normalizeFaultCode(rawCode);
      if (!code) continue;

      // ----------------------------------------------
      // 读取其它列（"同上" 会继承上一行）
      // ----------------------------------------------
      const rawFaultDescription = pickColumn(normalizedRow, ["故障描述"]);
      const rawAlarmReason = pickColumn(normalizedRow, ["报警原因"]);
      const rawControlAction = pickColumn(normalizedRow, ["控制系统动作"]);
      const rawResetType = pickColumn(normalizedRow, ["复位类型"]);
      const rawSolution = pickColumn(normalizedRow, ["解决方案"]);

      const resolveSame = (val, prev) => {
        if (!val) return prev;
        if (val === "同上") return prev;
        return val;
      };

      const faultDescription = resolveSame(
        rawFaultDescription,
        prevFaultDescription,
      );
      const alarmReason = resolveSame(rawAlarmReason, prevAlarmReason);
      const controlAction = resolveSame(rawControlAction, prevControlAction);
      const resetType = resolveSame(rawResetType, prevResetType);
      const solution = resolveSame(rawSolution, prevSolution);

      prevFaultDescription = faultDescription;
      prevAlarmReason = alarmReason;
      prevControlAction = controlAction;
      prevResetType = resetType;
      prevSolution = solution;

      const faultEntry = {
        alarmCode: code,
        faultDescription: faultDescription || null,
        alarmReason: alarmReason || null,
        controlAction: controlAction || null,
        resetType: resetType || null,
        solution: solution || null,
      };

      // ----------------------------------------------
      // 写入 map（区间码本身也写入）
      // ----------------------------------------------
      map.set(code, faultEntry);

      // ----------------------------------------------
      // 区间码展开：CM001~CM016 → CM001, CM002, ..., CM016
      // 以及 CM001~016 这种简写
      // ----------------------------------------------
      const rangeMatch =
        code.match(/^([A-Z]+)(\d+)~([A-Z]*)(\d+)$/) ||
        code.match(/^([A-Z]+)(\d+)~(\d+)$/);

      if (rangeMatch) {
        const prefix1 = rangeMatch[1] || "";
        const startStr = rangeMatch[2];
        const prefix2 = rangeMatch[3] || "";
        const endStr = rangeMatch[4] || rangeMatch[3] || "";

        // 避免把 "16" 解析成 prefix2
        let prefix = prefix1;
        let endStrClean = endStr;
        let startStrClean = startStr;

        // 处理 CM001~016 情况（第三段是纯数字）
        if (/^\d+$/.test(endStrClean) && !prefix2) {
          prefix = prefix1;
        } else {
          prefix = prefix1 || prefix2;
        }

        const start = parseInt(startStrClean, 10);
        const end = parseInt(endStrClean, 10);

        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          end >= start &&
          prefix
        ) {
          const width = startStrClean.length;

          for (let i = start; i <= end; i++) {
            const expanded = `${prefix}${String(i).padStart(width, "0")}`;
            if (!map.has(expanded)) {
              map.set(expanded, {
                ...faultEntry,
                alarmCode: expanded,
              });
            }
          }
        }
      }
    }

    return map;
  } catch (error) {
    console.error("[FaultCode] 加载失败:", error);
    return new Map();
  }
}

// 启动时加载一次
faultCodeMap = loadFaultCodeMap();

// ============================================================
// 运行状态判断规则
// ============================================================

const DEVICE_RUN_RULES = {
  Unit: 10,
  FirstCoolingPump: 0,
};

function parseDeviceRunStatus(deviceType, firstValue) {
  if (!(deviceType in DEVICE_RUN_RULES)) return null;

  const num = Number(firstValue);
  if (!Number.isFinite(num)) return null;

  return num > DEVICE_RUN_RULES[deviceType] ? "运行中" : "待机";
}

// ============================================================
// 告警语义
// ============================================================

const NORMAL_PATTERNS = [
  /无故障/,
  /无报警/,
  /无告警/,
  /正常/,
  /复位/,
  /清零/,
  /重置/,
  /清除/,
  /关闭/,
  /停止/,
  /禁用/,
];

const ALARM_PATTERNS = [
  /报警/,
  /告警/,
  /故障/,
  /异常/,
  /警告/,
  /超限/,
  /超温/,
  /超压/,
  /停机/,
];

// ============================================================
// Token 与 Java 请求参数处理
// ============================================================

function splitJavaParams(params = {}) {
  const queryParams = { ...params };
  const token = queryParams.token;

  delete queryParams.token;
  delete queryParams.authorization;
  delete queryParams.Authorization;

  return {
    token,
    queryParams,
  };
}

function assertJavaResponse(result, endpoint) {
  if (!result || typeof result !== "object") {
    throw new Error(`[Java] ${endpoint} 返回数据为空`);
  }

  if (
    result.code !== undefined &&
    ![0, 200, "0", "200"].includes(result.code)
  ) {
    const error = new Error(
      `[Java] ${endpoint} 请求失败：${result.msg || result.code}`,
    );

    error.code = result.code;
    throw error;
  }

  return result.data;
}

// ============================================================
// MySQL：获取设备总数
// ============================================================

export async function getDeviceCount() {
  const [rows] = await db.query(`
    SELECT COUNT(*) AS total
    FROM device
  `);

  return Number(rows[0]?.total || 0);
}

// ============================================================
// MySQL：获取异常设备
// ============================================================

export async function getAbnormalDevices() {
  const [rows] = await db.query(`
    SELECT id, name, status, type
    FROM device
    WHERE status != '正常'
    ORDER BY id DESC
    LIMIT 50
  `);

  return rows;
}

// ============================================================
// MySQL：获取设备列表
// ============================================================

export async function getDeviceList(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);

  const [rows] = await db.query(
    `
      SELECT id, name, status, type
      FROM device
      ORDER BY id DESC
      LIMIT ?
    `,
    [safeLimit],
  );

  return rows;
}

// ============================================================
// MySQL：获取设备状态统计
// ============================================================

export async function getDeviceStatus() {
  const [rows] = await db.query(`
    SELECT status, COUNT(*) AS count
    FROM device
    GROUP BY status
    ORDER BY count DESC
  `);

  return rows;
}

// ============================================================
// MySQL：根据关键词查询设备
// ============================================================

export async function searchDevices(keyword, limit = 10) {
  if (!keyword) return [];

  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);

  const search = `%${keyword}%`;

  const [rows] = await db.query(
    `
      SELECT id, name, status, type
      FROM device
      WHERE name LIKE ? OR type LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `,
    [search, search, safeLimit],
  );

  return rows;
}

// ============================================================
// Java：获取 faultFields 原始数据
// ============================================================

export async function fetchFaultFields(params = {}) {
  const { token, queryParams } = splitJavaParams(params);

  const response = await javaClient.get("rthsApi/iot/system/faultFields", {
    params: queryParams,
    ...(token ? { token } : {}),
  });

  const data = assertJavaResponse(
    response?.data,
    "rthsApi/iot/system/faultFields",
  );

  if (data == null) return [];

  if (!Array.isArray(data)) {
    throw new Error("[Java] faultFields 返回的数据不是数组");
  }

  return data;
}

// ============================================================
// 解析 description：
// "0=正常;1=警告;2=报警" → { 0: "正常", 1: "警告", 2: "报警" }
// ============================================================

function parseDescription(desc) {
  if (!desc || typeof desc !== "string") return null;

  const map = {};

  const parts = desc
    .split(/[;\n\r；]/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const match = part.match(
      /^(?:bit\s*=\s*)?(\d+(?:\.\d+)?)\s*[=:：]\s*(.+)$/i,
    );

    if (match) {
      map[Number(match[1])] = match[2].trim();
    }
  }

  return Object.keys(map).length ? map : null;
}

// ============================================================
// 根据含义判断是否为告警
// ============================================================

function judgeMeaningAsAlarm(meaning) {
  if (!meaning) return null;

  if (NORMAL_PATTERNS.some((re) => re.test(meaning))) {
    return false;
  }

  if (ALARM_PATTERNS.some((re) => re.test(meaning))) {
    return true;
  }

  return null;
}

// ============================================================
// 解析单个 faultField 的告警等级
// ============================================================

function parseAlarmLevel(item) {
  const value = Number(item?.value);

  if (!Number.isFinite(value)) return null;
  if (value === 0) return null;

  const descMap = parseDescription(item.description);

  if (descMap && descMap[value] !== undefined) {
    const meaning = descMap[value];
    const isAlarm = judgeMeaningAsAlarm(meaning);

    if (isAlarm === true) {
      return `告警（${meaning}）`;
    }

    if (isAlarm === false) {
      return null;
    }

    return `异常（${meaning}）`;
  }

  if (item.code === "Alarm") {
    if (value === 1) return "警告";
    if (value === 2) return "报警";

    return `异常(${value})`;
  }

  return "异常";
}

// ============================================================
// 从 faultFields 中提取异常字段
// ============================================================

export async function getAbnormalDevicesFromFault(params = {}) {
  const list = await fetchFaultFields(params);

  return list
    .map((item) => {
      const level = parseAlarmLevel(item);

      if (!level) return null;

      return {
        deviceId: item.deviceId,
        name: item.deviceName,
        type: DEVICE_TYPE_MAP[item.deviceType] || item.deviceType,
        code: item.code,
        level,
        value: item.value,
        runStatus: parseDeviceRunStatus(item.deviceType, item.value),
        description: item.description || "",
      };
    })
    .filter(Boolean);
}

// ============================================================
// Java：获取 overview 原始数据
// ============================================================

export async function fetchOverview(params = {}) {
  const { token, queryParams } = splitJavaParams(params);

  const response = await javaClient.get("rthsApi/iot/system/overview", {
    params: queryParams,
    ...(token ? { token } : {}),
  });

  const data = assertJavaResponse(
    response?.data,
    "rthsApi/iot/system/overview",
  );

  if (data == null) return [];

  if (!Array.isArray(data)) {
    throw new Error("[Java] overview 返回的数据不是数组");
  }

  return data;
}

// ============================================================
// 从 displayFields 中获取数值
// ============================================================

function getFieldValue(fields, code) {
  const field = (fields || []).find((item) => item.code === code);

  if (!field) return null;

  const num = Number(field.value);

  return Number.isFinite(num) ? num : null;
}

function getFieldUnit(fields, code) {
  const field = (fields || []).find((item) => item.code === code);

  return field?.unit || "";
}

// ============================================================
// 从 overview 中提取设备运行状态
// ============================================================

export async function getRunningDevicesFromOverview(params = {}) {
  const list = await fetchOverview(params);

  return list
    .map((item) => {
      const deviceType = item.deviceType;

      if (deviceType !== "Unit" && deviceType !== "FirstCoolingPump") {
        return null;
      }

      const fields = item.displayFields || [];
      const firstValue = Number(fields?.[0]?.value ?? 0);

      const isRunning =
        deviceType === "Unit" ? firstValue > 10 : firstValue > 0;

      const power = getFieldValue(fields, "P");
      const powerUnit = getFieldUnit(fields, "P") || "kW";
      const freq = getFieldValue(fields, "Freq");
      const load = getFieldValue(fields, "Load");
      const alarm = getFieldValue(fields, "Alarm");
      const offLine = getFieldValue(fields, "offLine");

      return {
        deviceId: item.deviceId,
        name: item.deviceName,
        deviceType,
        type: DEVICE_TYPE_MAP[deviceType] || deviceType,
        firstValue,
        isRunning,
        runStatus: isRunning ? "运行中" : "待机",
        power,
        powerUnit,
        freq,
        load,
        alarm,
        offLine,
      };
    })
    .filter(Boolean);
}

// ============================================================
// 兼容旧接口：从 faultFields 中获取所有字段
// ============================================================

export async function getDevicesWithRunStatusFromFault(params = {}) {
  const list = await fetchFaultFields(params);

  return list.map((item) => ({
    deviceId: item.deviceId,
    name: item.deviceName,
    type: DEVICE_TYPE_MAP[item.deviceType] || item.deviceType,
    code: item.code,
    value: item.value,
    level: parseAlarmLevel(item),
    runStatus: parseDeviceRunStatus(item.deviceType, item.value),
    description: item.description || "",
  }));
}

// ============================================================
// 获取设备列表：按 deviceId 聚合
// ============================================================

export async function getDeviceListFromFault(params = {}) {
  const list = await fetchFaultFields(params);

  const byDevice = new Map();

  for (const item of list) {
    if (!item?.deviceId) continue;
    if (item.deviceType === "UnitSystem") continue;

    const deviceId = String(item.deviceId);

    if (!byDevice.has(deviceId)) {
      byDevice.set(deviceId, {
        deviceId,
        name: item.deviceName,
        typeCode: item.deviceType,
        type: DEVICE_TYPE_MAP[item.deviceType] || item.deviceType,
        fields: {},
      });
    }

    if (item.code) {
      byDevice.get(deviceId).fields[item.code] = item.value;
    }
  }

  return Array.from(byDevice.values()).map((device) => {
    const alarmItem = {
      deviceId: device.deviceId,
      deviceName: device.name,
      deviceType: device.typeCode,
      code: "Alarm",
      value: device.fields.Alarm,
      description:
        list.find(
          (item) =>
            String(item.deviceId) === device.deviceId && item.code === "Alarm",
        )?.description || "",
    };

    return {
      deviceId: device.deviceId,
      name: device.name,
      type: device.type,
      level: parseAlarmLevel(alarmItem),
      runStatus: parseDeviceRunStatus(device.typeCode, device.fields.Alarm),
      fields: device.fields,
    };
  });
}

// ============================================================
// 故障详情解析工具
// ============================================================

function parseDist(dist) {
  if (!dist) return {};

  if (typeof dist === "object" && !Array.isArray(dist)) {
    return dist;
  }

  if (typeof dist === "string") {
    try {
      const parsed = JSON.parse(dist);

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 非 JSON 字符串，继续返回空映射
    }
  }

  return {};
}

function findDisplayField(displayFields, code) {
  if (!Array.isArray(displayFields)) return null;

  return displayFields.find((field) => field?.code === code) || null;
}

// ============================================================
// 获取设备详情
// ============================================================

export async function fetchDeviceDetail(deviceId, params = {}) {
  if (!deviceId) {
    throw new Error("获取设备详情失败：缺少 deviceId");
  }

  const { token, queryParams: baseParams } = splitJavaParams(params);

  if (!token) {
    throw new Error("获取设备详情失败：缺少 Token");
  }

  if (!baseParams.orgId) {
    throw new Error("获取设备详情失败：缺少 orgId");
  }

  const queryParams = {
    ...baseParams,
    deviceId,
    type: baseParams.type ?? 1,
  };

  // 明确保证 token 不会进入 query
  delete queryParams.token;

  const response = await javaClient.get("rthsApi/iot/system/detail", {
    params: queryParams,
    token,
  });

  const data = assertJavaResponse(response?.data, "rthsApi/iot/system/detail");

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("[Java] detail 返回的数据不是对象");
  }

  return data;
}

// ============================================================
// 解析 AlarmASCII1
//
// Java 返回：
//   value: "05#SW753"
//   dist:  { "05#SW753": "流量开关故障" }
//
// 处理顺序：
//   1. normalizeFaultCode → "SW753"
//   2. faultCodeMap.get("SW753")   → fault.xlsx
//   3. 如果 Excel 找不到，回退到 Java dist
//   4. 最后回退到 description
// ============================================================

function parseFaultReason(displayFields) {
  const faultField = findDisplayField(displayFields, "AlarmASCII1");

  if (!faultField) {
    console.warn("[FaultCode] detail 中没有找到 AlarmASCII1");

    return {
      faultCode: null,
      normalizedFaultCode: null,
      faultReason: null,
      alarmReason: null,
      controlAction: null,
      resetType: null,
      solution: null,
      source: null,
    };
  }

  const rawFaultCode = String(faultField.value ?? "").trim();
  const normalizedFaultCode = normalizeFaultCode(rawFaultCode);

  console.log("[FaultCode] Java 故障码：", {
    raw: rawFaultCode,
    normalized: normalizedFaultCode,
  });

  const excelFault = normalizedFaultCode
    ? faultCodeMap.get(normalizedFaultCode)
    : null;

  console.log("[FaultCode] Excel 查询：", {
    raw: rawFaultCode,
    normalized: normalizedFaultCode,
    matched: Boolean(excelFault),
    fault: excelFault || null,
  });

  if (excelFault) {
    return {
      faultCode: rawFaultCode || null,
      normalizedFaultCode: normalizedFaultCode || null,
      faultReason: excelFault.faultDescription || null,
      alarmReason: excelFault.alarmReason || null,
      controlAction: excelFault.controlAction || null,
      resetType: excelFault.resetType || null,
      solution: excelFault.solution || null,
      source: "fault.xlsx",
    };
  }

  // ---- Excel 没命中：回退 Java dist ----
  const dist = parseDist(faultField.dist);

  let faultReason = null;

  if (rawFaultCode && dist[rawFaultCode]) {
    faultReason = dist[rawFaultCode];
  }

  if (!faultReason && rawFaultCode) {
    const matchedKey = Object.keys(dist).find(
      (key) => String(key).trim() === rawFaultCode,
    );

    if (matchedKey) {
      faultReason = dist[matchedKey];
    }
  }

  if (
    !faultReason &&
    faultField.description &&
    String(faultField.description).trim()
  ) {
    faultReason = String(faultField.description).trim();
  }

  return {
    faultCode: rawFaultCode || null,
    normalizedFaultCode: normalizedFaultCode || null,
    faultReason: faultReason ? String(faultReason).trim() : null,
    alarmReason: null,
    controlAction: null,
    resetType: null,
    solution: null,
    source: faultReason ? "java" : null,
  };
}

// ============================================================
// 根据 AlarmASCII1.value 查找 Excel 故障码
// ============================================================

function lookupFaultCode(rawValue) {
  const originalCode = String(rawValue ?? "").trim();

  if (!originalCode) {
    return {
      originalCode: null,
      normalizedCode: null,
      matched: false,
      fault: null,
    };
  }

  const normalizedCode = normalizeFaultCode(originalCode);

  if (!normalizedCode) {
    return {
      originalCode,
      normalizedCode: null,
      matched: false,
      fault: null,
    };
  }

  const fault = faultCodeMap.get(normalizedCode);

  return {
    originalCode,
    normalizedCode,
    matched: Boolean(fault),
    fault: fault || null,
  };
}

// ============================================================
// 解析详情中的告警等级
// ============================================================

function getAlarmLevel(alarmField) {
  if (!alarmField) return "未知";

  const value = String(alarmField.value ?? "").trim();
  const description = String(alarmField.description ?? "").trim();

  if (value === "0" || value === "0.0") {
    return "正常";
  }

  if (value === "1" || value === "1.0") {
    return "警告";
  }

  if (value === "2" || value === "2.0") {
    return "报警";
  }

  const text = `${value} ${description}`;

  if (/无故障|无告警|无报警|正常/.test(text)) {
    return "正常";
  }

  if (/报警|严重故障/.test(text)) {
    return "报警";
  }

  if (/告警|警告|故障|异常/.test(text)) {
    return "告警";
  }

  return "未知";
}

function normalizeDeviceFaultDetail(detail) {
  const displayFields = Array.isArray(detail?.displayFields)
    ? detail.displayFields
    : [];

  const alarmField = findDisplayField(displayFields, "Alarm");
  const faultInfo = parseFaultReason(displayFields);

  return {
    deviceId: detail?.deviceId ?? null,
    name: detail?.deviceName ?? "未知设备",
    deviceType: detail?.deviceType ?? null,
    level: getAlarmLevel(alarmField),
    alarmValue: alarmField?.value ?? null,
    alarmDescription: alarmField?.description ?? null,

    faultCode: faultInfo.faultCode,
    normalizedFaultCode: faultInfo.normalizedFaultCode,

    faultReason: faultInfo.faultReason,
    alarmReason: faultInfo.alarmReason,
    controlAction: faultInfo.controlAction,
    resetType: faultInfo.resetType,
    solution: faultInfo.solution,
    faultSource: faultInfo.source,
  };
}

// ============================================================
// 从 faultFields 中按设备聚合数据
// ============================================================

function collectAlarmDevices(faultFields) {
  const rows = Array.isArray(faultFields) ? faultFields : [];

  const deviceMap = new Map();

  for (const item of rows) {
    if (!item?.deviceId) continue;

    const deviceId = String(item.deviceId);

    if (!deviceMap.has(deviceId)) {
      deviceMap.set(deviceId, {
        deviceId,
        deviceName: item.deviceName || "未知设备",
        deviceType: item.deviceType || null,
        fields: [],
      });
    }

    deviceMap.get(deviceId).fields.push(item);
  }

  const alarmDevices = [];

  for (const device of deviceMap.values()) {
    const alarmField = device.fields.find((field) => field?.code === "Alarm");

    // 没有 Alarm 字段时，不根据其他数值字段判定告警
    if (!alarmField) continue;

    const level = getAlarmLevel(alarmField);

    if (level === "正常" || level === "未知") {
      continue;
    }

    alarmDevices.push({
      ...device,
      level,
      alarmValue: alarmField.value ?? null,
      alarmDescription: alarmField.description ?? null,
    });
  }

  return alarmDevices;
}

// ============================================================
// 根据用户问题匹配指定设备
// ============================================================

function matchRequestedDevice(message, devices) {
  const text = String(message || "")
    .replace(/\s+/g, "")
    .toLowerCase();

  if (!text) return [];

  return devices.filter((device) => {
    const name = String(device.deviceName || "")
      .replace(/\s+/g, "")
      .toLowerCase();

    return name && text.includes(name);
  });
}

// ============================================================
// 判断是否在询问故障原因 / 处理方案 / 优化方案
// ============================================================

function isFaultAnalysisQuestion(message = "") {
  return /为什么|为何|什么原因|原因是什么|怎么回事|故障原因|报警原因|告警原因|故障原因分析|根因|排查原因|哪里坏了|什么故障|如何处理|怎么处理|怎样处理|如何解决|怎么解决|怎样解决|如何优化|怎么优化|怎样优化|优化异常|解决异常|处理异常|排查|修复|处理方案|解决方案|优化方案|处理建议|解决建议/.test(
    String(message),
  );
}

function isFaultRelatedQuestion(message = "") {
  return /故障|报警|告警|异常|坏了|不工作|停机|故障原因|报警原因|告警原因/.test(
    String(message),
  );
}

// ============================================================
// 查询设备具体故障原因
// ============================================================

export async function getDeviceFaultReasons(message, params = {}) {
  if (!params.token) {
    throw new Error("查询故障原因失败：缺少 Token");
  }

  if (!params.orgId) {
    throw new Error("查询故障原因失败：缺少 orgId");
  }

  const faultFields = await fetchFaultFields(params);
  const alarmDevices = collectAlarmDevices(faultFields);

  if (alarmDevices.length === 0) {
    return {
      type: "device_fault_reasons",
      message: "当前接口数据中未发现明确处于告警状态的设备。",
      devices: [],
    };
  }

  const matchedDevices = matchRequestedDevice(message, alarmDevices);

  // 点名设备时只查匹配设备；
  // 未点名时最多查询前 5 台告警设备。
  const targetDevices =
    matchedDevices.length > 0 ? matchedDevices : alarmDevices.slice(0, 5);

  const details = await Promise.all(
    targetDevices.map(async (device) => {
      try {
        const detail = await fetchDeviceDetail(device.deviceId, {
          ...params,
          type: params.type ?? 1,
        });

        const normalized = normalizeDeviceFaultDetail(detail);

        return {
          deviceId: normalized.deviceId || device.deviceId,
          name: normalized.name || device.deviceName,
          deviceType: normalized.deviceType || device.deviceType,
          type:
            DEVICE_TYPE_MAP[normalized.deviceType] ||
            DEVICE_TYPE_MAP[device.deviceType] ||
            device.deviceType,
          level: normalized.level === "未知" ? device.level : normalized.level,

          alarmValue: normalized.alarmValue ?? device.alarmValue,
          alarmDescription:
            normalized.alarmDescription ?? device.alarmDescription,

          // ==========================
          // 故障码
          // ==========================
          faultCode: normalized.faultCode,
          normalizedFaultCode: normalized.normalizedFaultCode,

          // ==========================
          // Excel 故障知识
          // ==========================
          faultReason: normalized.faultReason,
          alarmReason: normalized.alarmReason,
          controlAction: normalized.controlAction,
          resetType: normalized.resetType,
          solution: normalized.solution,
          faultSource: normalized.faultSource,

          detailAvailable: true,
        };
      } catch (error) {
        console.error(
          `[deviceService] detail 请求失败，deviceId=${device.deviceId}:`,
          error?.message || error,
        );

        return {
          deviceId: device.deviceId,
          name: device.deviceName,
          deviceType: device.deviceType,
          type: DEVICE_TYPE_MAP[device.deviceType] || device.deviceType,
          level: device.level,
          alarmValue: device.alarmValue,
          alarmDescription: device.alarmDescription,
          faultCode: null,
          faultReason: null,
          detailAvailable: false,
          detailError: error?.message || "详情接口请求失败",
        };
      }
    }),
  );

  console.log(
    "[DEVICE_FAULT_REASONS]",
    JSON.stringify(
      {
        queriedDevice:
          matchedDevices.length > 0 ? matchedDevices[0].deviceName : null,
        devices: details,
      },
      null,
      2,
    ),
  );

  return {
    type: "device_fault_reasons",
    queriedDevice:
      matchedDevices.length > 0 ? matchedDevices[0].deviceName : null,
    devices: details,
  };
}

// ============================================================
// 获取相关设备数据
// ============================================================

export async function getRelevantDevices(message, params = {}) {
  const text = String(message || "").trim();
  const lowerText = text.toLowerCase();

  if (!text) return [];

  // 1. 故障原因问题必须优先处理
  if (isFaultAnalysisQuestion(text) && isFaultRelatedQuestion(text)) {
    return getDeviceFaultReasons(text, params);
  }

  // 2. 设备运行状态
  if (
    /运行状态|运行情况|是否运行|正在运行|运行中的设备|待机|停机状态|开机状态/.test(
      text,
    )
  ) {
    try {
      return await getRunningDevicesFromOverview(params);
    } catch (error) {
      console.error("[RUN_STATUS_ERROR]", error?.message || error);
      throw error;
    }
  }

  // 3. 当前告警设备列表
  if (
    /异常设备|哪些设备故障|设备报警|告警设备|故障列表|报警列表|告警列表|哪些设备异常|当前故障|当前报警/.test(
      text,
    ) ||
    lowerText.includes("alarm")
  ) {
    try {
      return await getAbnormalDevicesFromFault(params);
    } catch (error) {
      console.error("[FAULT_FIELDS_ERROR]", error?.message || error);
      throw error;
    }
  }

  // 4. 一般故障问题也查询实时故障字段
  if (/故障|报警|告警|异常/.test(text)) {
    try {
      return await getAbnormalDevicesFromFault(params);
    } catch (error) {
      console.error("[FAULT_FIELDS_ERROR]", error?.message || error);
      throw error;
    }
  }

  // 5. 关键词匹配：沿用原来的 MySQL 查询
  const keywords = [
    "空调",
    "冷冻泵",
    "冷却泵",
    "风机",
    "变配电",
    "配电",
    "安防",
    "摄像头",
    "门禁",
  ];

  const keyword = keywords.find((item) => text.includes(item));

  if (keyword) {
    return searchDevices(keyword, 10);
  }

  return [];
}

// ============================================================
// Java：获取 totalEnergyAnalysis 原始数据
//
// 接口：GET rthsApi/energyEfficiency/totalEnergyAnalysis
// 参数：orgId、date（date 作为区间终点，返回最近一段区间）
//
// 响应：
//   {
//     code: 0,
//     msg: "success",
//     data: [
//       { date: "2026-09-17", value: 1259.41 },
//       ...
//       { date: "2026-10-16", value: 252.90 }
//     ]
//   }
// ============================================================

export async function fetchTotalEnergyAnalysis(params = {}) {
  const { token, queryParams } = splitJavaParams(params);

  const response = await javaClient.get(
    "rthsApi/energyEfficiency/totalEnergyAnalysis",
    {
      params: queryParams,
      ...(token ? { token } : {}),
    },
  );

  const data = assertJavaResponse(
    response?.data,
    "rthsApi/energyEfficiency/totalEnergyAnalysis",
  );

  if (data == null) return [];

  if (!Array.isArray(data)) {
    throw new Error("[Java] totalEnergyAnalysis 返回的数据不是数组");
  }

  // 统一格式，并按日期升序排序
  return data
    .filter(
      (item) =>
        item &&
        typeof item.date === "string" &&
        Number.isFinite(Number(item.value)),
    )
    .map((item) => ({
      date: String(item.date),
      value: Number(item.value),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// 判断是否是能耗问题
// ============================================================

export function isEnergyQuestion(message = "") {
  return /能耗|用电|电量|耗电|电能/.test(String(message || ""));
}

// ============================================================
// 查询能耗数据（供 routes/ai.js 使用）
//
// 根据用户问题返回不同结构：
//   - 问今日      → energy_today（含 today / yesterday / 环比）
//   - 问昨日      → energy_yesterday（含 today / yesterday / 环比）
//   - 问具体日期  → energy_specific_date
// ============================================================

export async function getEnergyData(message, params = {}) {
  if (!params.token) {
    throw new Error("查询能耗失败：缺少 Token");
  }
  if (!params.orgId) {
    throw new Error("查询能耗失败：缺少 orgId");
  }

  const text = String(message || "");

  const isToday = /今日|今天|当天/.test(text);
  const isYesterday = /昨日|昨天/.test(text);
  const specificDate = parseDateFromMessage(text);

  // 确定请求时用的终点日期
  //   - 具体日期 → 该日期
  //   - 昨日    → 昨天（返回区间也能覆盖到前天）
  //   - 今日    → 今天
  let queryDate = todayStr();

  if (specificDate) {
    queryDate = specificDate;
  } else if (isYesterday && !isToday) {
    queryDate = yesterdayStr();
  }

  const list = await fetchTotalEnergyAnalysis({
    ...params,
    date: queryDate,
  });

  // 日期 → 数值
  const map = new Map();
  for (const item of list) {
    map.set(item.date, item.value);
  }

  const allDates = list.map((x) => x.date).sort();
  const minDate = allDates[0] || queryDate;
  const maxDate = allDates[allDates.length - 1] || queryDate;

  // ---------- 具体日期查询 ----------
  if (specificDate) {
    const value = map.has(specificDate) ? map.get(specificDate) : 0;
    const inRange = specificDate >= minDate && specificDate <= maxDate;

    return {
      type: "energy_specific_date",
      targetDate: specificDate,
      targetValue: value,
      inRange,
      availableRange: { min: minDate, max: maxDate },
    };
  }

  // ---------- 今日 / 昨日对比 ----------
  const today = todayStr();
  const yesterday = yesterdayStr();

  const todayValue = map.has(today) ? map.get(today) : 0;
  const yesterdayValue = map.has(yesterday) ? map.get(yesterday) : 0;

  // 环比：以 (today - yesterday) / yesterday 计算
  let diffPercent = 0;
  let diffText = "0.00%";
  let diffSign = "";

  if (yesterdayValue !== 0) {
    diffPercent = ((todayValue - yesterdayValue) / yesterdayValue) * 100;
    diffText = Math.abs(diffPercent).toFixed(2) + "%";
    diffSign = diffPercent > 0 ? "+" : diffPercent < 0 ? "-" : "";
  }

  return {
    type: isYesterday && !isToday ? "energy_yesterday" : "energy_today",
    today: { date: today, value: todayValue },
    yesterday: { date: yesterday, value: yesterdayValue },
    diffPercent: `${diffSign}${diffText}`,
    diffDirection: diffPercent > 0 ? "上升" : diffPercent < 0 ? "下降" : "持平",
    availableRange: { min: minDate, max: maxDate },
  };
}

// ============================================================
// 能耗分析：返回今日 / 昨日 / 最近 7 天统计
// 供"能耗为什么下降"、"分析一下本周能耗"这类问题使用
// ============================================================

export async function getRecentEnergySummary(message, params = {}) {
  if (!params.token) {
    throw new Error("查询能耗分析失败：缺少 Token");
  }
  if (!params.orgId) {
    throw new Error("查询能耗分析失败：缺少 orgId");
  }

  const today = todayStr();
  const yesterday = yesterdayStr();

  const list = await fetchTotalEnergyAnalysis({
    ...params,
    date: today,
  });

  // 取最近 7 天（列表已按日期升序）
  const weekDays = list.slice(-7);

  const values = weekDays.map((x) => x.value);
  const total = values.reduce((a, b) => a + b, 0);
  const avg = values.length ? total / values.length : 0;
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;

  const maxItem = weekDays.find((x) => x.value === max);
  const minItem = weekDays.find((x) => x.value === min);

  const map = new Map();
  for (const item of list) {
    map.set(item.date, item.value);
  }

  const todayValue = map.get(today) ?? 0;
  const yesterdayValue = map.get(yesterday) ?? 0;

  let diffPercent = 0;
  if (yesterdayValue !== 0) {
    diffPercent = ((todayValue - yesterdayValue) / yesterdayValue) * 100;
  }

  const allDates = list.map((x) => x.date).sort();
  const minDate = allDates[0] || today;
  const maxDate = allDates[allDates.length - 1] || today;

  return {
    type: "energy_analysis",
    today: { date: today, value: todayValue },
    yesterday: { date: yesterday, value: yesterdayValue },
    diffPercent:
      (diffPercent > 0 ? "+" : diffPercent < 0 ? "-" : "") +
      Math.abs(diffPercent).toFixed(2) +
      "%",
    diffDirection: diffPercent > 0 ? "上升" : diffPercent < 0 ? "下降" : "持平",
    week: {
      days: weekDays, // [{ date, value }, ...]
      total: Number(total.toFixed(2)),
      avg: Number(avg.toFixed(2)),
      max: maxItem ? { date: maxItem.date, value: maxItem.value } : null,
      min: minItem ? { date: minItem.date, value: minItem.value } : null,
    },
    availableRange: { min: minDate, max: maxDate },
  };
}

// ============================================================
// Java：获取天气/负荷原始数据
//
// 接口：GET rthsApi/weather/queryFormatted
// 参数：
//   orgId
//   dates      = 2026-10-16
//   fields[]   = temp / windSpeed / humidity / load / text
//
// 响应：
//   {
//     code: 0,
//     msg: "success",
//     data: {
//       Q:         [0, 0, ...],
//       realityQ:  [91261.63, ...],   // 实际负荷
//       load:      ["0", "0", ...],   // 预测负荷
//       temp:      ["13", "14", ...],
//       humidity:  ["49", "49", ...],
//       windSpeed: ["3", "7", ...],
//       text:      ["多云", ...]
//     }
//   }
//
// 说明：
//   - 数组索引 = 时刻切片，切片粒度由数组长度推断：
//       24  → 1h
//       96  → 15min
//       288 → 5min
//   - load 为预测负荷，realityQ 为实际负荷
// ============================================================

export async function fetchWeatherFormatted(params = {}) {
  const { token, queryParams } = splitJavaParams(params);

  const response = await javaClient.get("rthsApi/weather/queryFormatted", {
    params: queryParams,
    ...(token ? { token } : {}),
  });

  const data = assertJavaResponse(
    response?.data,
    "rthsApi/weather/queryFormatted",
  );

  if (data == null) return null;

  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("[Java] weather/queryFormatted 返回的数据不是对象");
  }

  return data;
}

// ============================================================
// 判断是否是「负荷预测 / 峰值」类问题
// ============================================================

export function isLoadForecastQuestion(message = "") {
  return /负荷.*预测|预测.*负荷|负荷趋势|负荷峰值|峰值|预测负荷|负荷预测|负荷会|负荷达到|未来负荷/.test(
    String(message || ""),
  );
}

// ============================================================
// 查询负荷趋势预测
//
// 返回结构：
//   {
//     type: "load_forecast",
//     date: "2026-10-16",
//     stepMinutes: 5,           // 切片粒度
//     totalPoints: 288,
//     peak: {
//       index, time: "14:30", value,
//       temp, humidity, text,   // 峰值时刻的天气（可选）
//     },
//     now: {
//       index, value,           // 当前预测负荷
//       reality,                // 当前实际负荷
//     },
//   }
// ============================================================

export async function getLoadForecastData(message, params = {}) {
  if (!params.token) {
    throw new Error("查询负荷预测失败：缺少 Token");
  }
  if (!params.orgId) {
    throw new Error("查询负荷预测失败：缺少 orgId");
  }

  const today = todayStr();

  const data = await fetchWeatherFormatted({
    ...params,
    dates: today,
    // axios 会把数组序列化成 fields[]=temp&fields[]=windSpeed...
    fields: ["temp", "windSpeed", "humidity", "load", "text"],
  });

  if (!data) {
    return {
      type: "load_forecast",
      date: today,
      peak: null,
      message: "今日暂无负荷数据。",
    };
  }

  const toNums = (arr) => (Array.isArray(arr) ? arr.map((v) => Number(v)) : []);

  const realityQ = toNums(data.realityQ);
  const load = toNums(data.load);
  const temp = toNums(data.temp);
  const humidity = toNums(data.humidity);
  const textArr = Array.isArray(data.text) ? data.text : [];

  const len = Math.max(load.length, realityQ.length);

  if (len === 0) {
    return {
      type: "load_forecast",
      date: today,
      peak: null,
      message: "今日暂无负荷数据。",
    };
  }

  // ---- 推断切片粒度 ----
  let stepMinutes = 60;
  if (len >= 200) stepMinutes = 5;
  else if (len >= 80) stepMinutes = 15;
  else if (len >= 40) stepMinutes = 30;

  // ---- 找预测负荷峰值 ----
  let peakIdx = 0;
  let peakVal = -Infinity;

  for (let i = 0; i < load.length; i++) {
    const v = load[i];
    if (Number.isFinite(v) && v > peakVal) {
      peakVal = v;
      peakIdx = i;
    }
  }

  if (!Number.isFinite(peakVal) || peakVal <= 0) {
    return {
      type: "load_forecast",
      date: today,
      peak: null,
      message: "今日暂无有效的负荷预测数据。",
    };
  }

  // ---- 索引 → HH:mm ----
  const idxToTime = (i) => {
    const totalMin = i * stepMinutes;
    const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  // ---- 当前时刻索引 ----
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowIdx = Math.min(
    Math.max(0, Math.floor(nowMin / stepMinutes)),
    len - 1,
  );

  return {
    type: "load_forecast",
    date: today,
    stepMinutes,
    totalPoints: len,
    peak: {
      index: peakIdx,
      time: idxToTime(peakIdx),
      value: peakVal,
      temp: Number.isFinite(temp[peakIdx]) ? temp[peakIdx] : null,
      humidity: Number.isFinite(humidity[peakIdx]) ? humidity[peakIdx] : null,
      text: textArr[peakIdx] || null,
    },
    now: {
      index: nowIdx,
      time: idxToTime(nowIdx),
      value: Number.isFinite(load[nowIdx]) ? load[nowIdx] : null,
      reality: Number.isFinite(realityQ[nowIdx]) ? realityQ[nowIdx] : null,
    },
  };
}

// ============================================================
// 冷冻泵 / 设备点位控制
//
// 前端调用：
//   controlApi({
//     deviceId: "xxx",      // 系统设备 ID（如 FirstCoolingPumpSystem 的 deviceId）
//     orgId: "xxx",
//     type: 1,
//     pointValues: {
//       PumpControlMode: "0",   // 0=手动 1=PLC自控 2=智控
//       SSC1: "1",              // 1=启动 0=停止（1号泵）
//       FreqSet1: "50"          // 频率设定
//     }
//   })
//
// Java 接口路径如不一致，只改这里：
// ============================================================

// ============================================================
// 冷冻泵 / 设备点位控制
// ============================================================

const JAVA_CONTROL_PATH = "rthsApi/iot/system/operate";

const CONTROL_POINT_ALLOW_PATTERNS = [
  /^PumpControlMode$/,
  /^SSC\d+$/,
  /^FreqSet\d+$/,
];

function isAllowedControlPoint(code) {
  return CONTROL_POINT_ALLOW_PATTERNS.some((re) => re.test(code));
}

// ============================================================
// 解析自然语言控制指令
//
// 支持：
//   "启动1号冷冻泵" / "开启1号泵" / "打开1号泵"
//   "关闭2号冷冻泵" / "停止2号泵"
//   "把3号泵频率调到45Hz" / "设置2号泵频率为50"
//   "将1号泵切到手动" / "把2号泵切换到PLC自控" / "1号泵改到智控"
//   "启动所有冷冻泵" / "关闭全部泵"
//
// 返回 null → 不是控制意图
// ============================================================
// ============================================================
// 解析自然语言控制指令
//
// 关键约束：
//   1. 必须是"要操作某台泵"的明确指令
//   2. 排除查询类/建议类语句（运行建议、策略、状态、异常...）
//   3. 排除疑问句
// ============================================================
export function parsePumpControlCommand(message) {
  const text = String(message || "").trim();
  if (!text) return null;

  // ---------- 1. 前置排除：明显是"查询/建议/故障分析"类，不当作控制 ----------
  const isQueryOrAdvice =
    /运行建议|优化建议|建议|策略|方案|运行状态|设备状态|状态如何|运行情况|是否运行|正在运行|运行中|运行中的设备|待机|停机状态|开机状态|异常|故障|报警|告警|坏了|不工作|为什么|为何|什么原因|怎么回事|怎么排查|如何|怎么|怎样|是什么|是多少|多少|几台|哪些|有哪些|有没有|能否|可以吗|吗|呢/.test(
      text,
    );

  if (isQueryOrAdvice) return null;

  // ---------- 2. 必须包含泵相关关键词 ----------
  const hasPumpWord =
    /冷冻泵|水泵|泵组|泵系统|\d+\s*[号#台个]?\s*泵|[一二三四五六七八九十]\s*[号#台个]?\s*泵|泵/.test(
      text,
    );

  if (!hasPumpWord) return null;

  // ---------- 3. 泵编号 ----------
  const numMap = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  let pumpNum = null;

  // "1号泵" / "第1台泵" / "1#泵" / "1号冷冻泵"
  let m = text.match(
    /(?:第\s*)?(\d+)\s*(?:号|#|台|个)?\s*(?:冷冻泵|水泵|泵|机组)/,
  );
  if (m) pumpNum = Number(m[1]);

  // "第1台" / "1台"（前面已经确认有泵词）
  if (pumpNum === null) {
    m = text.match(/(?:第\s*)?(\d+)\s*(?:号|#|台|个)/);
    if (m) pumpNum = Number(m[1]);
  }

  // 中文数字
  if (pumpNum === null) {
    const cnMatch = text.match(
      /(?:第\s*)?([一二三四五六七八九十])\s*(?:号|#|台|个)?\s*(?:冷冻泵|水泵|泵|机组)/,
    );
    if (cnMatch) pumpNum = numMap[cnMatch[1]] || null;
  }

  if (pumpNum === null) {
    const cnOnly = text.match(
      /(?:第\s*)?([一二三四五六七八九十])\s*(?:号|#|台|个)/,
    );
    if (cnOnly) pumpNum = numMap[cnOnly[1]] || null;
  }

  const isAll = /全部|所有|都|每一台|每台|全开|全关/.test(text);

  // ---------- 4. 启停动词：去掉裸"运行" ----------
  const wantsStart =
    /启动|开启|打开|开机|开一下|启动一下|通电|跑起来|运行起来|开起来|运转起来/.test(
      text,
    );
  const wantsStop =
    /关闭|停止|停掉|关机|停机|关一下|停一下|断电|停下来|关掉/.test(text);

  // ---------- 5. 频率 ----------
  const hasFreqKeyword = /频率|Hz|赫兹/i.test(text);
  let freq = null;

  if (hasFreqKeyword) {
    const hasAdjustVerb =
      /调到|调至|调为|设定|设置|设为|改为|改到|切到|切至|转为/.test(text);
    if (hasAdjustVerb) {
      const fm = text.match(/(\d+(?:\.\d+)?)\s*(?:Hz|赫兹)?/i);
      if (fm) freq = Number(fm[1]);
    }
  }

  // ---------- 6. 模式 ----------
  let mode = null;
  const hasModeVerb =
    /切换到|切到|切至|切为|切换至|切换|设为|设置|调到|调至|调为|改到|改为|转为|转到|换成/.test(
      text,
    );

  if (hasModeVerb) {
    if (/手动|手控/.test(text)) mode = "0";
    else if (/PLC|自控|自动控制|自动运行/i.test(text)) mode = "1";
    else if (/智控|智能控制|智能运行/.test(text)) mode = "2";
  }

  // ---------- 7. 至少识别出一个动作 ----------
  if (!wantsStart && !wantsStop && freq === null && mode === null) {
    return null;
  }

  return {
    pumpNum,
    isAll,
    wantsStart,
    wantsStop,
    freq,
    mode,
  };
}
// ============================================================
// 把 pointValues 转成人话，用于回复用户
// ============================================================
export function describeControlPoints(pointValues) {
  const parts = [];

  if (pointValues.PumpControlMode !== undefined) {
    const modeMap = { 0: "手动", 1: "PLC自控", 2: "智控" };
    const label =
      modeMap[pointValues.PumpControlMode] || pointValues.PumpControlMode;
    parts.push(`控制模式切到 ${label}`);
  }

  // 启停
  const startList = [];
  const stopList = [];
  for (const [code, value] of Object.entries(pointValues)) {
    if (code.startsWith("SSC")) {
      const n = code.slice(3);
      if (value === "1") startList.push(`${n}号泵`);
      else stopList.push(`${n}号泵`);
    }
  }
  if (startList.length) parts.push(`启动 ${startList.join("、")}`);
  if (stopList.length) parts.push(`停止 ${stopList.join("、")}`);

  // 频率
  for (const [code, value] of Object.entries(pointValues)) {
    if (code.startsWith("FreqSet")) {
      const n = code.slice(7);
      parts.push(`${n}号泵频率设为 ${value}Hz`);
    }
  }

  return parts.join("，");
}

export async function controlDevice(params = {}) {
  const { deviceId, orgId, type = 1, pointValues, token } = params;

  if (!deviceId) {
    const err = new Error("控制失败：缺少 deviceId");
    err.code = 400;
    throw err;
  }

  if (!orgId) {
    const err = new Error("控制失败：缺少 orgId");
    err.code = 400;
    throw err;
  }

  if (!token) {
    const err = new Error("控制失败：缺少 Token");
    err.code = 401;
    throw err;
  }

  if (
    !pointValues ||
    typeof pointValues !== "object" ||
    Array.isArray(pointValues) ||
    Object.keys(pointValues).length === 0
  ) {
    const err = new Error("控制失败：pointValues 不能为空");
    err.code = 400;
    throw err;
  }

  // 1. 点位合法性校验
  for (const [code, value] of Object.entries(pointValues)) {
    if (!isAllowedControlPoint(code)) {
      const err = new Error(`控制失败：不允许下发点位 ${code}`);
      err.code = 400;
      throw err;
    }

    if (value === undefined || value === null || String(value) === "") {
      const err = new Error(`控制失败：点位 ${code} 的值不能为空`);
      err.code = 400;
      throw err;
    }
  }

  // 2. 清洗成字符串
  const cleanPointValues = {};
  for (const [code, value] of Object.entries(pointValues)) {
    cleanPointValues[code] = String(value);
  }

  console.log("[CONTROL_DEVICE]", {
    deviceId,
    orgId,
    type,
    pointValues: cleanPointValues,
  });

  // 3. 转发到 Java
  let response;
  try {
    response = await javaClient.post(
      JAVA_CONTROL_PATH,
      {
        deviceId,
        orgId,
        type,
        pointValues: cleanPointValues,
      },
      {
        token,
        timeoutMs: 10000,
      },
    );
  } catch (error) {
    const err = new Error(error?.message || "控制指令下发失败，请稍后重试");
    err.code = error?.status || error?.response?.status || 502;
    err.isJavaError = true;
    throw err;
  }

  // 4. 取 Java 返回体
  const result = response?.data;

  console.log("[CONTROL_DEVICE_RES]", JSON.stringify(result));

  if (!result || typeof result !== "object") {
    const err = new Error("控制接口返回数据为空");
    err.code = 502;
    err.isJavaError = true;
    throw err;
  }

  // 5. 兼容多种成功返回
  const ok =
    result.code === 0 ||
    result.code === 200 ||
    result.code === "0" ||
    result.code === "200" ||
    result.msg === "success" ||
    result.success === true;

  if (!ok) {
    const err = new Error(result.msg || "控制指令下发失败");
    err.code = result.code || 500;
    err.isJavaError = true;
    err.raw = result;
    throw err;
  }

  return {
    success: true,
    message: result.msg || "指令下发成功",
    data: result.data ?? null,
  };
}

// ============================================================
// 从 overview 中解析冷冻泵系统（FirstCoolingPumpSystem）的真实 deviceId
// ============================================================
export async function resolvePumpSystemDeviceId(params = {}) {
  const list = await fetchOverview({
    ...params,
    type: params.type ?? 1,
  });

  const pumpSystem = list.find(
    (item) => item?.deviceType === "FirstCoolingPumpSystem" && item?.deviceId,
  );

  console.log("[PUMP_SYSTEM_ID_RESOLVE]", {
    total: list.length,
    found: Boolean(pumpSystem),
    deviceId: pumpSystem?.deviceId || null,
    deviceName: pumpSystem?.deviceName || null,
  });

  return pumpSystem?.deviceId || null;
}

// ============================================================
// 今日运行建议（策略）
//
// 接口：GET rthsApi/strategy/todaylist?orgId=xxx&type=1
//
// 返回：
//   {
//     code: 0,
//     data: [
//       {
//         id: "55f1...",
//         strategyDetail: "冷机出水温度: 10.0℃;冷冻泵频率: 40 Hz;",
//         strategyJson: "{\"waterTemp\": 10, \"chillerFreq\": 40}",
//         analysisJson: "{\"chw_eff\":100,\"energy_saving_rate\":0}",
//         createTime: "2026-10-22 09:25:13",
//         executeTime: "2026-10-21 14:45:05",
//         status: null,
//         ...
//       }
//     ]
//   }
// ============================================================

function parseJsonSafe(str, fallback = {}) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normalizeStrategy(raw) {
  const strategy = parseJsonSafe(raw?.strategyJson, {});
  const analysis = parseJsonSafe(raw?.analysisJson, {});

  return {
    id: raw?.id ?? null,
    moduleId: raw?.moduleId ?? null,
    createTime: raw?.createTime ?? null,
    executeTime: raw?.executeTime ?? null,
    status: raw?.status ?? null,
    strategyDetail: raw?.strategyDetail ?? "",
    strategy,
    analysis,
    // 常用指标
    chwEff: Number(analysis.chw_eff) || 0,
    energySavingRate: Number(analysis.energy_saving_rate) || 0,
    fitness: Number(analysis.fitness) || 0,
  };
}

export async function fetchTodayStrategies(params = {}) {
  const { token, queryParams } = splitJavaParams(params);

  if (!token) {
    throw new Error("查询运行建议失败：缺少 Token");
  }
  if (!queryParams.orgId) {
    throw new Error("查询运行建议失败：缺少 orgId");
  }

  const response = await javaClient.get("rthsApi/strategy/todaylist", {
    params: {
      orgId: queryParams.orgId,
      type: queryParams.type ?? 1,
    },
    token,
  });

  const data = assertJavaResponse(response?.data, "rthsApi/strategy/todaylist");

  if (data == null) return [];

  if (!Array.isArray(data)) {
    throw new Error("[Java] strategy/todaylist 返回的数据不是数组");
  }

  return data.map(normalizeStrategy);
}

// ============================================================
// 应用运行建议
//
// 接口：POST rthsApi/iot/system/updateStatus
// 参数：{ id, orgId, type }
// ============================================================

export async function applyStrategyById(params = {}) {
  const { id, orgId, type = 1, token } = params;

  if (!id) {
    const err = new Error("应用运行建议失败：缺少 id");
    err.code = 400;
    throw err;
  }
  if (!orgId) {
    const err = new Error("应用运行建议失败：缺少 orgId");
    err.code = 400;
    throw err;
  }
  if (!token) {
    const err = new Error("应用运行建议失败：缺少 Token");
    err.code = 401;
    throw err;
  }

  console.log("[STRATEGY_APPLY]", { id, orgId, type });

  let response;
  try {
    response = await javaClient.put(
      "rthsApi/iot/system/updateStatus",
      { id, orgId, type },
      { token, timeoutMs: 10000 },
    );
  } catch (error) {
    const err = new Error(error?.message || "应用运行建议失败，请稍后重试");
    err.code = error?.status || 502;
    err.isJavaError = true;
    throw err;
  }

  const result = response?.data;

  console.log("[STRATEGY_APPLY_RES]", JSON.stringify(result));

  if (!result || typeof result !== "object") {
    const err = new Error("应用运行建议接口返回数据为空");
    err.code = 502;
    err.isJavaError = true;
    throw err;
  }

  const ok =
    result.code === 0 ||
    result.code === 200 ||
    result.code === "0" ||
    result.code === "200" ||
    result.msg === "success" ||
    result.success === true;

  if (!ok) {
    const err = new Error(result.msg || "应用运行建议失败");
    err.code = result.code || 500;
    err.isJavaError = true;
    err.raw = result;
    throw err;
  }

  return {
    success: true,
    message: result.msg || "运行建议已应用",
    data: result.data ?? null,
  };
}

// ============================================================
// 应用运行建议：先根据用户输入解析"第几条"
//
// 规则：
//   - 有指定序号（"第2条"、"2号建议"）→ 用指定
//   - 无指定（"应用建议"、"执行策略"）→ 用第 1 条
//
// 返回：{ index: number }，index 从 1 开始
// ============================================================
export function parseStrategyApplyIndex(message) {
  const text = String(message || "").trim();

  const cnMap = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };

  // "第1条" / "第2条" / "第 3 条"
  let m = text.match(/第\s*(\d+)\s*条/);
  if (m) return { index: Number(m[1]) };

  // "第一条" / "第二条"
  m = text.match(/第\s*([一二三四五六七八九十])\s*条/);
  if (m) return { index: cnMap[m[1]] || null };

  // "2号建议" / "3号策略"
  m = text.match(/(\d+)\s*号?\s*(?:建议|策略|方案)/);
  if (m) return { index: Number(m[1]) };

  // "应用这条" / "最新的" / "首条" / "第一条"
  if (/这条|该条|上面|刚才|最新|首条|第一条/.test(text)) {
    return { index: 1 };
  }

  // 没指定 → 默认第一条
  return { index: 1 };
}
