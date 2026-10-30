// routes/device.js
import express from "express";
import { javaClient } from "./javaProxy.js";
import {
  controlDevice,
  resolvePumpSystemDeviceId,
} from "../services/deviceService.js";

const router = express.Router();

// ==============================
// 设备树（转发 Java 的 tree 接口）
// GET /device/tree?orgId=xxx&type=1
// ==============================
router.get("/tree", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/energyEfficiency/tree", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[DEVICE_TREE_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取设备树失败" });
  }
});

// ==============================
// 设备状态
// ==============================
router.get("/status", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/iot/system/overview", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[DEVICE_STATUS_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取设备状态失败" });
  }
});

// ==============================
// 设备详情
// ==============================
router.get("/detail", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/iot/system/detail", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[DEVICE_DETAIL_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取设备详情失败" });
  }
});

// ==============================
// 能耗
// ==============================
router.get("/energy", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/iot/system/energy", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[DEVICE_ENERGY_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取能耗失败" });
  }
});

// ==============================
// 告警分页
// ==============================
router.get("/fault/page", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/iot/device/fault/page", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[FAULT_PAGE_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取告警失败" });
  }
});

// ==============================
//  具体设备告警/异常
// ==============================
router.get("/faultFields", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/iot/system/faultFields", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[WEATHER_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取天气失败" });
  }
});

// ==============================
// 天气
// ==============================
router.get("/weather", async (req, res) => {
  try {
    const { data } = await javaClient.get("rthsApi/weather/queryFormatted", {
      params: req.query,
    });
    res.json(data);
  } catch (e) {
    console.error("[WEATHER_ERROR]", e.message);
    res.status(500).json({ code: 500, message: "获取天气失败" });
  }
});

// ============================================================
// 冷冻泵 / 设备点位控制
//
// POST /device/control
// Body:
//   {
//     "deviceId": "xxx",
//     "orgId": "xxx",
//     "type": 1,
//     "pointValues": { "SSC1": "1", "PumpControlMode": "0" }
//   }
//
// Header:
//   Authorization: Bearer xxx
// ============================================================
router.post("/control", async (req, res) => {
  const requestId = req.headers["x-request-id"] || `ctrl-${Date.now()}`;

  try {
    const { deviceId, orgId, type = 1, pointValues } = req.body || {};

    // Token 兼容 Bearer / 裸 token
    const rawAuth = req.get("Authorization") || "";
    const token = rawAuth.replace(/^Bearer\s+/i, "").trim();

    const result = await controlDevice({
      deviceId,
      orgId,
      type,
      pointValues,
      token,
    });

    return res.json({
      code: 0,
      msg: result.message,
      requestId,
      data: result.data,
    });
  } catch (error) {
    const status = error?.code || 500;

    console.error("[DEVICE_CONTROL_ERROR]", {
      requestId,
      status,
      message: error?.message,
    });

    // Token 失效
    if (status === 401) {
      return res.status(401).json({
        code: 401,
        requestId,
        msg: "登录凭证无效或已过期，请重新登录",
      });
    }

    // 参数错误
    if (status === 400) {
      return res.status(400).json({
        code: 400,
        requestId,
        msg: error.message || "参数错误",
      });
    }

    // Java 业务错误 / 网络错误
    return res.status(status === 502 ? 502 : 500).json({
      code: status,
      requestId,
      msg: error.message || "控制指令下发失败，请稍后重试",
    });
  }
});

// ============================================================
// 查询冷冻泵系统的真实 deviceId
//
// GET /device/pump-system-id?orgId=xxx&type=1
// Header: Authorization: xxx
// ============================================================
router.get("/pump-system-id", async (req, res) => {
  const requestId = req.headers["x-request-id"] || `pump-id-${Date.now()}`;

  try {
    const rawAuth = req.get("Authorization") || "";
    const token = rawAuth.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return res.status(401).json({
        code: 401,
        requestId,
        msg: "缺少登录凭证",
      });
    }

    const orgId = req.user?.orgId || req.query?.orgId || null;

    if (!orgId) {
      return res.status(400).json({
        code: 400,
        requestId,
        msg: "缺少 orgId",
      });
    }

    const deviceId = await resolvePumpSystemDeviceId({
      token,
      orgId,
      type: req.query?.type || 1,
    });

    if (!deviceId) {
      return res.status(404).json({
        code: 404,
        requestId,
        msg: "未找到冷冻泵系统设备（FirstCoolingPumpSystem）",
        data: { deviceId: null },
      });
    }

    return res.json({
      code: 0,
      msg: "success",
      requestId,
      data: { deviceId },
    });
  } catch (error) {
    console.error("[PUMP_SYSTEM_ID_ERROR]", {
      requestId,
      message: error?.message,
    });

    return res.status(error?.status || 500).json({
      code: error?.status || 500,
      requestId,
      msg: error?.message || "查询冷冻泵系统 ID 失败",
    });
  }
});

export default router;
