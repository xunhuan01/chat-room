// 批量压缩 posts_media/ 下所有视频（历史视频压缩）
// 用法: node compress_existing_videos.js [--force]
// 说明: 遍历 data/posts_media/ 里的视频文件，逐个 ffmpeg 压缩（同路径替换，URL 不变）
//       压缩后比原文件大则保留原文件。--force 会重压已压缩过的（一般不需要）
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const POSTS_MEDIA_DIR = path.join(__dirname, 'data', 'posts_media');
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v'];
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FORCE = process.argv.includes('--force');

// 已压缩标记文件：记录已压过的文件名（压缩后比原文件小才算成功）
const MARK_FILE = path.join(__dirname, 'data', 'compressed_videos.json');

function loadMarks() {
  try { return JSON.parse(fs.readFileSync(MARK_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveMarks(m) {
  try { fs.writeFileSync(MARK_FILE, JSON.stringify(m, null, 2)); } catch (e) { console.error('saveMarks failed:', e.message); }
}

function compressOne(filePath) {
  return new Promise((resolve) => {
    const size = fs.statSync(filePath).size;
    const tmpPath = filePath + '.tmp.mp4';
    const args = [
      '-y', '-i', filePath,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      tmpPath
    ];
    execFile(FFMPEG_BIN, args, { timeout: 15 * 60 * 1000 }, (err) => {
      if (err) {
        console.error('  [FAIL]', path.basename(filePath), ':', (err.message || '').slice(0, 100));
        try { fs.unlinkSync(tmpPath); } catch {}
        resolve(false);
        return;
      }
      try {
        const compressedSize = fs.statSync(tmpPath).size;
        if (compressedSize < size) {
          fs.renameSync(tmpPath, filePath);
          console.log('  [OK]', path.basename(filePath), (size/1048576).toFixed(1)+'MB ->', (compressedSize/1048576).toFixed(1)+'MB', '省', ((1-compressedSize/size)*100).toFixed(0)+'%');
          resolve(true);
        } else {
          fs.unlinkSync(tmpPath);
          console.log('  [SKIP]', path.basename(filePath), '压缩后更大，保留原文件');
          resolve(false);
        }
      } catch (e) {
        console.error('  [FAIL]', path.basename(filePath), 'rename:', e.message);
        try { fs.unlinkSync(tmpPath); } catch {}
        resolve(false);
      }
    });
  });
}

(async () => {
  if (!fs.existsSync(POSTS_MEDIA_DIR)) {
    console.log('目录不存在:', POSTS_MEDIA_DIR);
    return;
  }
  const files = fs.readdirSync(POSTS_MEDIA_DIR)
    .filter(f => VIDEO_EXTS.includes(path.extname(f).toLowerCase()))
    .filter(f => !f.endsWith('.tmp.mp4'));
  const marks = loadMarks();
  const todo = FORCE ? files : files.filter(f => !marks[f]);
  console.log(`共 ${files.length} 个视频，待压缩 ${todo.length} 个（已压 ${files.length - todo.length} 个）`);
  if (todo.length === 0) { console.log('无需处理'); return; }

  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    console.log(`[${i+1}/${todo.length}] ${f}`);
    const success = await compressOne(path.join(POSTS_MEDIA_DIR, f));
    if (success) { marks[f] = true; ok++; }
    else fail++;
    saveMarks(marks);
  }
  console.log(`\n完成: 成功 ${ok}, 跳过/失败 ${fail}`);
})();
