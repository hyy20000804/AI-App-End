<div align="center">

# ⚙️ 融天 · 智慧楼宇 AI 服务端 (Backend)

**基于 Node.js + Express + DeepSeek 构建的智能物联网与 AI 分析中枢**

提供设备数据聚合、自然语言设备控制、故障诊断知识库检索与多轮对话 AI 助手能力

![Node.js](https://img.shields.io/badge/Node.js-18.x-339933?logo=node.js)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express)
![AI](https://img.shields.io/badge/LLM-DeepSeek-blue)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

---

## 📖 项目简介

本项目是**融天智慧园区管理系统**的后端服务端。它作为前端 App（React Native）与企业内部 Java 业务系统（`rthsApi`）之间的**智能中枢**，不仅提供基础的数据代理，还接入了大语言模型（DeepSeek），将复杂的设备运行数据转化为**自然语言交互、故障归因分析和智能控制指令**。

### 🌟 核心能力

- 🧠 **AI 意图识别与对话**：理解用户自然语言提问（能耗分析、负荷预测、设备状态），自动路由并调用对应业务接口。
- 🎛 **自然语言设备控制**：支持通过对话直接下发冷冻泵控制指令（如“开启1号冷冻泵”、“把3号泵频率调到45Hz”）。
- 📊 **能耗与负荷深度分析**：自动计算今日/昨日环比、近7天趋势、峰值谷值，并交由大模型生成节能建议。
- 🩺 **故障知识库与归因**：内置 `fault.xlsx` 故障码知识库，自动剥离硬件返回码前缀（如 `05#SW753` → `SW753`），精准输出故障原因与解决方案。
- 🔄 **多轮会话上下文**：内置 Session 管理，支持对话历史追溯，并在长对话中自动触发摘要生成，节省 Token。
- 🛡 **Java 接口安全代理**：统一封装对外部 Java 系统的请求，透传 Token、处理超时并统一错误降级。

---

## 🏗️ 架构设计

```text
[ 前端 React Native App ]
         │ (发起对话 / API请求)
         ▼
┌───────────────────────────────────────────────┐
│                Node.js 服务端                 │
│                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌───────┐  │
│  │  Router 层  │  │  Service 层 │  │ Utils │  │
│  │  (ai.js)    │→ │(deviceService)│→ │(llm)  │  │
│  └─────────────┘  └─────────────┘  └───────┘  │
│         │                │                    │
└─────────┼────────────────┼────────────────────┘
          │ (透传Token)    │ (执行本地/外部逻辑)
          ▼                ▼
┌─────────────────┐  ┌─────────────────────────┐
│ DeepSeek API 层 │  │ 企业 Java 业务系统 (rths) │
│ (内容生成/意图) │  │ (设备状态/能耗/控制)      │
└─────────────────┘  └─────────────────────────┘
```

---

## 🛠️ 技术栈

| 分类         | 技术                        | 说明                                  |
| ------------ | --------------------------- | ------------------------------------- |
| **核心框架** | Node.js (ESM) + Express     | 轻量级、高并发的 API 服务             |
| **AI 引擎**  | OpenAI SDK (兼容 DeepSeek)  | 调用 `deepseek-chat` 处理复杂文本推理 |
| **数据库**   | MySQL (`mysql2`)            | 设备基础信息查询                      |
| **数据解析** | `xlsx`                      | 解析外部故障码 Excel 知识库           |
| **会话存储** | 内存级 Map (SessionService) | 支持自动过期清理与上下文摘要          |
| **外部通信** | 原生 `fetch` (Node 18+)     | 代理 Java 后端接口请求                |
| **日志追踪** | 自研 Logger + RequestId     | 全链路追踪，记录 AI Token 消耗与耗时  |

---

## 📂 目录结构

```text
backend/
├── data/                  # 静态数据或缓存
├── node_modules/          # 依赖包
├── routes/                # 路由控制器
│   ├── ai.js              # AI 核心交互路由 (处理 chat, 意图分流)
│   ├── device.js          # 设备基础数据路由
│   ├── javaProxy.js       # 企业 Java 系统 HTTP 请求代理封装
│   └── session.js         # AI 会话管理路由 (历史、列表、删除)
├── services/              # 核心业务逻辑层
│   ├── aiService.js       # AI 提示词构建与 LLM 调用
│   ├── deviceService.js   # 设备数据拉取、状态计算、故障码解析、控制指令下发
│   └── sessionService.js  # 对话上下文生命周期管理
├── utils/                 # 工具类
│   ├── intent.js          # 基础正则意图识别
│   └── logger.js          # 日志记录与 AI Token 消耗统计
├── .env                   # 环境变量配置
├── app.js                 # 应用入口与全局路由挂载
├── db.js                  # MySQL 数据库连接池
├── fault.xlsx             # 内置故障码知识库 (Excel)
├── llm.js                 # 大模型客户端初始化
├── package.json           # 项目依赖
└── user.json              # 本地调试用 Mock 用户数据
```

---

## 🚀 快速开始

### 1. 环境准备

请确保已安装 **Node.js >= 18.0**（由于使用了原生 `fetch`），以及可用的 **MySQL 8.0** 和 **Java 业务系统接口**（默认指向 `http://8.141.94.167`）。

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

在根目录创建 `.env` 文件，参考以下配置：

```env
# 服务端口 (默认 8091)
PORT=8091

# AI 模型配置 (DeepSeek)
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxx
DEEPSEEK_MODEL=deepseek-chat
AI_TIMEOUT=30000

# Java 业务系统基础地址 (必须配置准确)
JAVA_BASE_URL=http://8.141.94.167

# 数据库配置
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=password
DB_NAME=rongtian

# 功能开关 (是否开启多轮上下文记忆)
ENABLE_SESSION_CONTEXT=true
NODE_ENV=development
```

### 4. 启动服务

```bash
# 开发模式 (需安装 nodemon 或 node --watch)
npm run dev

# 生产模式
npm start
```

启动成功后终端会输出类似如下信息（包含局域网IP，方便真机调试）：

```text
====================================
融天AI服务器启动成功
Local:   http://localhost:8091
Network: http://192.168.1.100:8091
AI:      http://192.168.1.100:8091/ai/chat
Device:  http://192.168.1.100:8091/device
====================================
```

---

## 🔌 核心接口说明

### 1. AI 对话交互 `/ai/chat`

- **Method**: `POST`
- **Headers**: `Authorization: <token>` （必须，透传给 Java 系统）
- **Body**:

```json
{
  "message": "开启手动模式并开启1号冷冻泵",
  "sessionId": "uuid-string",
  "orgId": "your-org-id"
}
```

- **核心工作流**（在 `routes/ai.js` 中实现）：
  1. **控制指令拦截**：通过 `parsePumpControlCommand` 识别是否为设备控制操作，若是直接下发 Java 接口并返回结果。
  2. **策略应用拦截**：识别是否为“应用第X条建议”，处理策略下发。
  3. **策略查询拦截**：识别是否为“今日运行建议”，拉取策略列表并格式化。
  4. **数据查询路由**：根据意图（设备数量、设备状态、能耗、负荷预测等）拉取真实数据。
  5. **大模型生成**：需要分析或解答的复杂问题，调用 `chatWithAI` 结合数据上下文生成回答。
  6. **联想清洗**：通过 `stripTipBlock` 剥离生成文本中多余的建议，并转存为 `relatedQuestions` 数组返回。

### 2. 会话管理 `/ai/session`

- `POST /create`：创建一个新会话。
- `GET /list`：获取当前所有历史会话列表。
- `GET /history?sessionId=xxx`：获取特定会话的完整聊天记录。
- `DELETE /history?sessionId=xxx`：清空特定会话记录。
- `DELETE /:sessionId`：删除特定会话。

### 3. 设备基础服务 `/device`

- 提供设备列表查询、状态汇总、详情查询等底层数据接口。

---

## 🧠 核心业务逻辑解析

### 🩺 故障知识库解析 (`fault.xlsx`)

`deviceService.js` 在服务启动时会加载根目录下的 `fault.xlsx`。
Java 系统返回的 `AlarmASCII1` 常带有前缀（如 `05#SW753`）。服务端自动利用 `normalizeFaultCode` 将其剥离为纯字母数字 `SW753`，并匹配 Excel 中的故障描述、排查动作与解决方案。**支持区间展开**（如 `CM001~CM016` 自动映射为 16 条故障码）。

### 🎛 自然语言控制解析 (`parsePumpControlCommand`)

`deviceService.js` 内置了高鲁棒性的正则解析器，能精准提取：

- **对象**：`1号泵` / `第一台泵` / `所有泵` / `泵组`
- **动作**：`启动` / `关闭` / `频率调到45`
- **模式**：`手动` / `PLC自控` / `智控`
  结合排他逻辑（自动排除带“怎么”、“为什么”、“如何”等疑问词），防止误下发控制指令，确保生产安全。

### 📉 能耗与负荷的“防幻觉”处理

`aiService.js` 中的 `formatBusinessData` 专门对业务数据进行了**结构化 Prompt 注入**：

- **能耗分析**：自动生成最近7天的 Markdown 表格，并明确指示 AI “表格不计入简洁限制”、“原因和建议均用 - 开头列出”。
- **负荷分析**：提取峰值时间、温度、湿度，要求 AI 用 3~5 句话概括。
- 通过这种“数据预格式化”，完全杜绝了 AI 面对大量 JSON 数据时胡编乱造、遗漏关键指标的现象。

### 🔄 Session 自动上下文 (Session Context)

- **无感记忆**：采用 `Map` 缓存会话，默认过期时间 30 分钟。
- **滑动窗口**：每次对话，自动将最近 6 轮历史（`MAX_HISTORY_ROUNDS`）带入 Prompt。
- **摘要压缩**：当对话达到 12 轮（`SUMMARY_TRIGGER_ROUNDS`）时，自动调用小模型将历史压缩为 `summary`，保留核心上下文信息，防止超出 Token 限制导致对话崩溃。

### 🛡 Java 请求代理层 (`javaProxy.js`)

统一封装了 Java 系统的 GET、POST、PUT 请求。

- **自动超时控制**：默认 15 秒超时拦截，避免 Node.js 进程被拖垮。
- **错误统一捕获**：将 Java 返回的 401（鉴权）、403（无权限）、502/504（服务不可用/超时）转换为标准 Node.js Error，方便全局捕获。
- **避免日志泄露**：对于 POST/PUT 的控制类指令，日志只打印路径不打印 body，防止敏感数据暴露。

---

## 📝 开发与调试建议

- **日志追踪**：每个请求（`/ai/chat`）都会携带唯一的 `requestId`。控制台搜索 `[AI_SUCCESS]` 可查看完整响应耗时；搜索 `[JAVA_REQ]` 可追踪代理请求情况。
- **接口排错**：若报错 `401` 或 `502`，请检查 `.env` 中的 `JAVA_BASE_URL` 是否可达，并确认前端 Header 是否正确透传了 `token`。
- **AI 调参**：`aiService.js` 中的 `systemPrompt` 高度定制化，若需调整 AI 的语气（更活泼/更严谨/更简短），直接修改 Prompt 的“回答风格要求”区块即可生效，无需改动业务代码。
- **新增意图**：若需支持新的专属查询（例如“今日室内温度”），在 `routes/ai.js` 顶部编写对应的正则匹配函数（如 `isTempQuestion`），并在 `/chat` 路由内部添加分支逻辑，直接查询并返回格式化文本。

---

<div align="center">

**融天智能 · 让每一度电都有 AI 的智慧**

</div>
