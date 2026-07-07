#!/usr/bin/env node
/**
 * chat-room 日志清理脚本
 * 删除 data/chat_logs/ 中超过 3 天的聊天记录
 * 完全不碰 data/pending/（离线队列）
 *
 * 用法: node cleanup_logs.js
 * 建议: crontab 每天凌晨 3 点执行
 */

const fs = require('fs');
const path = require('path');

const CHAT_ROOM_DIR = __dirname;
const DATA_DIR = path.join(CHAT_ROOM_DIR, 'data');
const CHAT_LOGS_DIR = path.join(DATA_DIR, 'chat_logs');
const MAX_AGE_DAYS = 3;

function cleanup() {
  // 检查目录是否存在
  if (!fs.existsSync(CHAT_LOGS_DIR)) {
    console.log('聊天日志目录不存在，跳过');
    return;
  }

  const files = fs.readdirSync(CHAT_LOGS_DIR)
    .filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('没有日志文件需要清理');
    return;
  }

  const now = Date.now();
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000; // 3天的毫秒数
  let totalDeleted = 0;
  let totalFiles = 0;

  for (const file of files) {
    const filePath = path.join(CHAT_LOGS_DIR, file);
    let logs;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      logs = JSON.parse(raw);
    } catch (e) {
      console.error(`❌ 无法解析 ${file}: ${e.message}`);
      continue;
    }

    if (!Array.isArray(logs) || logs.length === 0) continue;

    const before = logs.length;
    const filtered = logs.filter(entry => {
      if (!entry.timestamp) return true; // 没时间戳的保留
      const entryTime = new Date(entry.timestamp).getTime();
      if (isNaN(entryTime)) return true; // 非法时间戳也保留
      return (now - entryTime) < maxAge;
    });
    const after = filtered.length;
    const deleted = before - after;

    if (deleted > 0) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
        console.log(`🗑️  ${file}: 删了 ${deleted} 条，剩下 ${after} 条`);
        totalDeleted += deleted;
        totalFiles++;
      } catch (e) {
        console.error(`❌ 写入 ${file} 失败: ${e.message}`);
      }
    }
  }

  if (totalDeleted === 0) {
    console.log('✅ 所有记录都在 3 天内，无需清理');
  } else {
    console.log(`\n📊 清理完成：${totalFiles} 个文件，共删除 ${totalDeleted} 条记录`);
  }
}

cleanup();
