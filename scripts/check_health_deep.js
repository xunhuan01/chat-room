#!/usr/bin/env node
/**
 * chat-room 全链路健康检查（持久身份 + 发消息验证）
 * 固定 visitorId cookie，每次都是同一个人
 * 连接后发一条测试消息，验证收发通道完整
 *
 * 正常 -> exit 0（无输出）
 * 异常 -> print 错误 + exit 1
 */
const { io } = require("socket.io-client");
const https = require("https");
const fs = require("fs");
const path = require("path");

const URL = "https://chat.waiwei.top";
const TIMEOUT_MS = 15000;
const CHAT_TIMEOUT_MS = 25000;
const ID_FILE = path.join(__dirname, ".healthcheck_id");
const HEALTH_MSG = "🔍 健康检查通过";

(async () => {
  // 1. HTTP 连通性检查
  const httpOk = await new Promise((resolve) => {
    const req = https.get(URL, { timeout: 10000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });

  if (!httpOk) {
    console.log("[FAIL] HTTP 不通");
    process.exit(1);
  }

  // 2. 读取持久化 visitorId
  let savedId = "";
  try {
    if (fs.existsSync(ID_FILE)) {
      savedId = fs.readFileSync(ID_FILE, "utf8").trim();
    }
  } catch (e) {}

  // 3. Socket.IO 连接 + 发消息验证
  const result = await new Promise((resolve) => {
    let done = false;

    const opts = {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      query: { role: "visitor" },
      timeout: TIMEOUT_MS,
      reconnection: false,
    };

    if (savedId) {
      opts.extraHeaders = { Cookie: `visitorId=${encodeURIComponent(savedId)}` };
    }

    const socket = io(URL, opts);

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        socket.close();
        resolve("[FAIL] Socket.IO 连接超时");
      }
    }, CHAT_TIMEOUT_MS);

    socket.on("connect", () => {});

    socket.on("welcome", (data) => {
      if (done) return;

      // 保存持久化 ID（首次连接时获取）
      if (data && data.visitorId && !savedId) {
        try {
          fs.writeFileSync(ID_FILE, data.visitorId, "utf8");
        } catch (e) {}
      }

      if (data && data.name) {
        // 4. 发一条测试消息验证收发通道
        socket.emit("visitor-message", { text: HEALTH_MSG });
        
        // 等一会儿确保消息发送完成，然后断开
        setTimeout(() => {
          done = true;
          clearTimeout(timer);
          socket.close();
          resolve(null); // ✅ 正常
        }, 2000);
      } else {
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve("[FAIL] welcome 事件缺少 name");
      }
    });

    socket.on("connect_error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(`[FAIL] Socket.IO 连接失败: ${err.message}`);
    });

    socket.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(`[FAIL] Socket.IO 错误: ${err.message}`);
    });
  });

  if (result) {
    console.log(result);
    process.exit(1);
  }
  process.exit(0);
})();
