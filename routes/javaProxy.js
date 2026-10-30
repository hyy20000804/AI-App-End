// routes/javaProxy.js

const JAVA_BASE = process.env.JAVA_BASE_URL || "http://8.141.94.167";

function buildUrl(path, params) {
  const base = JAVA_BASE.endsWith("/") ? JAVA_BASE : `${JAVA_BASE}/`;

  const cleanPath = path.startsWith("/") ? path.slice(1) : path;

  const url = new URL(cleanPath, base);

  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

function createJavaError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.isJavaError = true;
  return error;
}

// ============================================================
// 内部：带 body 的请求（POST / PUT / PATCH 共用）
//
// 参数：
//   method    : "POST" | "PUT"
//   path      : Java 相对路径（如 rthsApi/iot/system/updateStatus）
//   body      : 请求体 object，会 JSON.stringify
//   options   : { token, params?, timeoutMs? }
// ============================================================
async function requestWithBody(method, path, body = {}, options = {}) {
  const { params = {}, token, timeoutMs = 15000 } = options;

  if (typeof token !== "string" || !token.trim()) {
    throw createJavaError(401, "缺少当前用户的 Authorization Token");
  }

  const fullUrl = buildUrl(path, params);
  const started = Date.now();
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    // 不输出 body，避免控制指令 / 敏感数据进入日志
    console.log(`[JAVA_REQ] ${method}`, path);

    const response = await fetch(fullUrl, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: token.trim(),
        "User-Agent": "RongTian/1.0",
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });

    console.log("[JAVA_RES]", response.status, `${Date.now() - started}ms`);

    if (!response.ok) {
      // 尝试读一下 Java 返回的 msg，方便定位（不把整段正文打进日志）
      let errorMsg = "";
      try {
        const cloned = response.clone();
        const errJson = await cloned.json();
        errorMsg = errJson?.msg || errJson?.message || "";
      } catch {
        // 忽略
      }

      await response.body?.cancel().catch(() => {});

      throw createJavaError(
        response.status,
        errorMsg
          ? `Java 接口请求失败：${errorMsg}`
          : `Java 接口请求失败：HTTP ${response.status}`,
      );
    }

    let data;

    try {
      data = await response.json();
    } catch {
      throw createJavaError(502, "Java 接口返回的 JSON 格式无效");
    }

    return { data };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createJavaError(504, "Java 接口请求超时");
    }

    if (error?.isJavaError) {
      throw error;
    }

    console.error("[JAVA_ERR]", error.message);

    throw createJavaError(502, "Java 接口连接失败");
  } finally {
    clearTimeout(timer);
  }
}

export const javaClient = {
  // ============================================================
  // GET
  // ============================================================
  async get(path, options = {}) {
    const { params = {}, token } = options;

    if (typeof token !== "string" || !token.trim()) {
      throw createJavaError(401, "缺少当前用户的 Authorization Token");
    }

    const fullUrl = buildUrl(path, params);
    const started = Date.now();
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      console.log("[JAVA_REQ] GET", path);

      const response = await fetch(fullUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: token.trim(),
          "User-Agent": "RongTian/1.0",
        },
        signal: controller.signal,
      });

      console.log("[JAVA_RES]", response.status, `${Date.now() - started}ms`);

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});

        throw createJavaError(
          response.status,
          `Java 接口请求失败：HTTP ${response.status}`,
        );
      }

      let data;

      try {
        data = await response.json();
      } catch {
        throw createJavaError(502, "Java 接口返回的 JSON 格式无效");
      }

      return { data };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw createJavaError(504, "Java 接口请求超时");
      }

      if (error?.isJavaError) {
        throw error;
      }

      console.error("[JAVA_ERR]", error.message);

      throw createJavaError(502, "Java 接口连接失败");
    } finally {
      clearTimeout(timer);
    }
  },

  // ============================================================
  // POST
  //
  // 用法：
  //   javaClient.post(path, body, { token, params?, timeoutMs? })
  // ============================================================
  async post(path, body = {}, options = {}) {
    return requestWithBody("POST", path, body, options);
  },

  // ============================================================
  // PUT
  //
  // 用法：
  //   javaClient.put(path, body, { token, params?, timeoutMs? })
  //
  // 与 POST 行为完全一致：
  //   - 走 Authorization 头
  //   - body 走 JSON.stringify
  //   - 支持 timeoutMs（默认 15000）
  //   - 错误统一 isJavaError
  // ============================================================
  async put(path, body = {}, options = {}) {
    return requestWithBody("PUT", path, body, options);
  },
};
