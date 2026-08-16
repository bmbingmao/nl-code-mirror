#!/usr/bin/env node
// NL Code Mirror — MVP 后端
// 三栏自然语言编程镜像编辑器(文件树 | 代码 | 逐行描述,双向同步)
// 用法: node server/server.js [项目目录] [端口]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

let ROOT = path.resolve(process.argv[2] || process.env.PROJECT_DIR || path.join(os.homedir(), 'projects'));
const PORT = parseInt(process.argv[3] || process.env.PORT || '8787', 10);
const PUBLIC = path.join(__dirname, '..'); // 前端文件在项目根(index.html/app.js/style.css)
const MONACO = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min');

// ---- LLM 配置(默认本地 ollama,OpenAI 兼容;可用环境变量覆盖) ----
const LLM = {
  baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1',
  apiKey: process.env.LLM_API_KEY || 'ollama-local',
  model: process.env.LLM_MODEL || 'qwen2.5vl:7b',
};

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf',
};
const IGNORE_DIRS = new Set(['node_modules', '.cache', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv']);
const TEXT_EXT = new Set(['.c', '.h', '.py', '.js', '.ts', '.tsx', '.jsx', '.rs', '.go', '.java', '.kt', '.cpp', '.hpp', '.cc', '.sh', '.md', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.lua', '.rb', '.php', '.sql', '.xml', '.txt', '.zig', '.vue', '.svelte', '.cfg', '.properties', '.conf', '.ini', '.lang', '.env', '.mcmeta', '.txt']);

// 描述持久化目录(不污染用户项目)
const DESC_DIR = path.join(os.homedir(), '.local', 'share', 'nl-code-mirror', 'descs');
fs.mkdirSync(DESC_DIR, { recursive: true });
function codeHash(code) { return crypto.createHash('sha1').update(code).digest('hex').slice(0, 12); }
function descFileFor(rel) { return path.join(DESC_DIR, rel.replace(/[\\/]/g, '__') + '.json'); }
// 提示词版本:版本变更后,已保存的旧描述会自动重新生成
const PROMPT_VERSION = 3;

// 用户自定义可修改扩展名(持久化)
const EXT_FILE = path.join(DESC_DIR, 'exts.json');
let CUSTOM_EXTS = new Set();
try { CUSTOM_EXTS = new Set(JSON.parse(fs.readFileSync(EXT_FILE, 'utf8')).exts || []); } catch {}
function normExt(e) {
  e = String(e).trim().toLowerCase();
  if (!e) return null;
  if (!e.startsWith('.')) e = '.' + e;
  return e;
}
function saveExts() { fs.writeFileSync(EXT_FILE, JSON.stringify({ exts: [...CUSTOM_EXTS] })); }

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

function walkDir(dir, base, depth, out) {
  if (depth > 10) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.isDirectory() ? 0 : 1) - (b.isDirectory() ? 0 : 1) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: rel, dir: true, children: [] });
      walkDir(full, base, depth + 1, out[out.length - 1].children);
      if (!out[out.length - 1].children.length) delete out[out.length - 1].children;
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) || CUSTOM_EXTS.has(path.extname(e.name).toLowerCase())) {
      let size = 0; try { size = fs.statSync(full).size; } catch {}
      if (size > 512 * 1024) continue; // 跳过 >512KB 文本
      out.push({ name: e.name, path: rel, dir: false, size });
    }
  }
}

function safePath(p) {
  const full = path.resolve(ROOT, p || '');
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

// 生成项目目录结构文本(给 LLM 作上下文,深度 2,最多 60 条)
function projectTreeText() {
  const out = [];
  (function walk(dir, depth) {
    if (depth > 2 || out.length >= 60) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() ? 0 : 1) - (b.isDirectory() ? 0 : 1) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      out.push('  '.repeat(depth) + (e.isDirectory() ? '📁 ' + e.name + '/' : '📄 ' + e.name));
      if (out.length >= 60) { out.push('  …(截断)'); return; }
      if (e.isDirectory()) walk(full, depth + 1);
    }
  })(ROOT, 0);
  return out.join('\n') || '(空项目)';
}

// ---- LLM 调用(OpenAI 兼容;可用请求级 llm 覆盖,否则用环境变量默认) ----
async function llmChat(messages, { json = false, maxTokens = 8192, temp = 0.2, llm } = {}) {
  const cfg = { ...LLM, ...(llm || {}) };
  if (!cfg.baseUrl || !cfg.model) throw new Error('未配置 LLM:请在设置里填 baseUrl/model/key');
  const body = {
    model: cfg.model,
    messages,
    temperature: temp,
    max_tokens: maxTokens,
    stream: false,
  };
  // DeepSeek V4 系列(deepseek-v4-flash/pro)必须带 thinking 参数,否则 API 报 model not found;
  // V4 思考模式与 response_format json_object 不兼容,JSON 约束靠 prompt + 容错解析
  const isV4 = /v4-(flash|pro)/.test(cfg.model);
  if (isV4) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = cfg.reasoningEffort || 'low';
  }
  if (json && !isV4) { body.response_format = { type: 'json_object' }; }
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || 'none'}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000), // 3 分钟超时,防止请求永久挂起
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    log('LLM 请求失败', { url, model: cfg.model, status: res.status, body: t.slice(0, 200) });
    throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  return text;
}

function extractJson(text) {
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// 代码 → 逐行自然语言描述(详细,像翻译;带行号精确对齐)
// 代码 → 逐行自然语言描述(大白话;超长代码分段生成,行号全局归位)
const CHUNK_SIZE = 80; // 每段最大行数,防止 LLM 省略缩写
async function explainCode(code, filePath, llm) {
  const lang = path.extname(filePath).slice(1) || 'code';
  const total = code.split('\n').length;
  const allLines = new Array(total).fill('');
  // 解释详细度:0=极简(老手),100=最详细(小白),数值即详细度
  const detail = Number(llm && llm.detailLevel != null ? llm.detailLevel : 40);
  let levelDesc;
  if (detail < 30) levelDesc = '面向资深程序员:只讲关键点,极简,术语直接用,绝不解释任何基础概念。';
  else if (detail < 70) levelDesc = '面向有编程经验的开发者:解释代码意图和关键点,术语可直接使用,不用解释基础概念。';
  else levelDesc = '面向完全不懂编程的新手:解释要尽量详细,把术语、语法、API 的作用都讲清楚,像教学一样。';
  const sys = `你是资深程序员,用大白话给新手讲解代码。
把用户给出的 ${lang} 代码逐行解释成通俗易懂的中文口语,像朋友在旁边给你讲代码一样。
要求:
- 严格只输出 JSON 对象:{"lines":{"1":"第1行解释","2":"第2行解释",...}},key 是行号,value 是该行的解释。
- 代码每一行都必须有对应 key(包括空行,空行给空字符串"");行号必须与代码一致,不能省略、不能跳行。
- 千万不要逐字翻译代码。要讲"这行在干嘛、为什么这么写、和上下文什么关系"。
- 举例:代码 const $ = (id) => document.getElementById(id); 写"定义一个函数 $,接收参数 id,返回 document.getElementById(id) 的结果,即按 id 获取页面元素"。
- 大括号/括号行(如 {、})给简短说明(如"函数体开始"、"块结束")或留空。
- 只做客观、准确的翻译解释:说明这行代码的字面意思和直接作用。不要添加主观感受、情绪、个人评价或推测(如"很方便"、"偷懒"、"太多就看不完了"这类都不要)。
- 用大白话,通俗易懂,但保持客观。
- ${levelDesc}
- 描述字符串内不要使用双引号(用单引号或改写),不要包含真实换行(用\n表示)。
- 不要输出 JSON 以外的任何内容。`;

  const chunks = [];
  for (let s = 1; s <= total; s += CHUNK_SIZE) chunks.push([s, Math.min(s + CHUNK_SIZE - 1, total)]);
  if (chunks.length > 1) log('长文件 ' + total + ' 行,分 ' + chunks.length + ' 段生成');

  for (const [s, e] of chunks) {
    const numbered = code.split('\n').slice(s - 1, e).map((l, i) => (s + i) + ': ' + l).join('\n');
    let linesObj = null, text = '';
    for (let attempt = 1; attempt <= 3 && !linesObj; attempt++) {
      text = await llmChat([{ role: 'system', content: sys }, { role: 'user', content: '项目根目录: ' + ROOT + '\n项目结构(简略):\n' + projectTreeText() + '\n\n当前文件: ' + filePath + ' (第 ' + s + '-' + e + ' 行)\n\n带行号的代码:\n' + numbered }], { json: true, maxTokens: 32768, llm });
      const j = extractJson(text);
      if (j) {
        linesObj = j.lines;
        if (!linesObj && typeof j === 'object') {
          const keys = Object.keys(j);
          if (keys.length && keys.every(k => /^\d+$/.test(k))) linesObj = j;
        }
      }
      if (!linesObj && attempt < 3) log('段 ' + s + '-' + e + ' 解析失败(第 ' + attempt + ' 次),自动重试');
    }
    if (!linesObj) throw new Error('第 ' + s + '-' + e + ' 行段 3 次尝试均返回格式异常: ' + (text || '(空返回)').slice(0, 200));
    if (Array.isArray(linesObj)) {
      linesObj.forEach((v, i) => { const n = s + i; if (n <= e) allLines[n - 1] = String(v ?? ''); });
      if (linesObj.length !== e - s + 1) log('段 ' + s + '-' + e + ' 行数不符(数组): LLM=' + linesObj.length + ' 期望=' + (e - s + 1));
    } else if (typeof linesObj === 'object') {
      let matched = 0;
      for (const [k, v] of Object.entries(linesObj)) {
        const n = parseInt(k, 10);
        if (Number.isFinite(n) && n >= s && n <= e) { allLines[n - 1] = String(v ?? ''); matched++; }
      }
      if (matched < e - s + 1) log('段 ' + s + '-' + e + ' 行号覆盖不足: ' + matched + '/' + (e - s + 1));
    }
    log('段 ' + s + '-' + e + ' 完成');
  }
  return allLines;
}
// 逐行自然语言描述 → 修改代码
async function applyNl(code, filePath, lines) {
  const lang = path.extname(filePath).slice(1) || 'code';
  const lineTxt = lines.map((d, i) => `${i + 1}: ${(d || '').trim() || '(保持原样)'}`).join('\n');
  const sys = `你是 ${lang} 代码编辑助手。用户给出代码和"逐行目标描述"(行号: 描述)。你的任务:让代码严格符合这些描述。
规则:
- 只输出修改后的完整代码,用 \`\`\` 代码块包裹,不要任何解释。
- 描述为"(保持原样)"的行不要改动。
- 描述要求"删除/移除"某行或某段时,删掉对应代码。
- 保持原有代码风格、缩进、注释;描述没提到的地方不要改动。
- 输出必须完整(整文件),不能省略。`;
  const text = await llmChat([{ role: 'system', content: sys }, { role: 'user', content: `文件: ${filePath}\n\n逐行目标描述:\n${lineTxt}\n\n当前代码:\n\`\`\`\n${code}\n\`\`\`` }], { temp: 0.1, maxTokens: 32768, llm });
  const m = text.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/);
  if (m) return m[1];
  return text; // 没包代码块就按纯文本
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    // API
    if (p === '/api/tree') {
      const out = []; walkDir(ROOT, ROOT, 0, out);
      return json(res, { root: ROOT, tree: out });
    }
    if (p === '/api/set-root' && req.method === 'POST') {
      const { dir } = await readBody(req);
      if (!dir) return json(res, { error: '参数缺失' }, 400);
      const full = path.resolve(dir);
      let st;
      try { st = fs.statSync(full); } catch { return json(res, { error: '目录不存在: ' + full }, 400); }
      if (!st.isDirectory()) return json(res, { error: '不是目录: ' + full }, 400);
      ROOT = full;
      const out = []; walkDir(ROOT, ROOT, 0, out);
      log('切换项目根 →', ROOT);
      return json(res, { root: ROOT, tree: out });
    }
    if (p === '/api/list-dirs') {
      // 目录选择器:列出任意路径的子目录
      const dir = url.searchParams.get('path') || os.homedir();
      const full = path.resolve(dir);
      let st;
      try { st = fs.statSync(full); } catch { return json(res, { error: '目录不存在' }, 400); }
      if (!st.isDirectory()) return json(res, { error: '不是目录' }, 400);
      let entries = [];
      try {
        entries = fs.readdirSync(full, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {}
      return json(res, { path: full, dirs: entries, parent: path.dirname(full) });
    }
    if (p === '/api/file') {
      const full = safePath(url.searchParams.get('path') || '');
      if (!full) return json(res, { error: '路径越界' }, 400);
      const code = fs.readFileSync(full, 'utf8');
      return json(res, { path: url.searchParams.get('path'), code, lang: path.extname(full).slice(1), codeHash: codeHash(code) });
    }
    if (p === '/api/desc') {
      const rel = url.searchParams.get('path') || '';
      const f = descFileFor(rel);
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        return json(res, { lines: d.lines, codeHash: d.codeHash, ts: d.ts, version: d.version });
      } catch { return json(res, { lines: null }); }
    }
    if (p === '/api/exts' && req.method === 'POST') {
      const { exts } = await readBody(req);
      CUSTOM_EXTS = new Set((Array.isArray(exts) ? exts : []).map(normExt).filter(Boolean));
      saveExts();
      log('自定义扩展名:', [...CUSTOM_EXTS].join(', ') || '(空)');
      return json(res, { exts: [...CUSTOM_EXTS] });
    }
    if (p === '/api/exts') {
      return json(res, { exts: [...CUSTOM_EXTS] });
    }
    if (p === '/api/explain' && req.method === 'POST') {
      const { path: fp, code, llm } = await readBody(req);
      if (!fp || typeof code !== 'string') return json(res, { error: '参数缺失' }, 400);
      const lines = await explainCode(code, fp, llm);
      // 成功后持久化,下次打开文件直接加载
      try {
        fs.writeFileSync(descFileFor(fp), JSON.stringify({ lines, codeHash: codeHash(code), ts: Date.now(), version: PROMPT_VERSION }));
      } catch (e) { log('desc 保存失败', e.message); }
      return json(res, { lines });
    }
    if (p === '/api/apply-nl' && req.method === 'POST') {
      const { path: fp, code, lines, llm } = await readBody(req);
      if (!fp || typeof code !== 'string' || !Array.isArray(lines)) return json(res, { error: '参数缺失' }, 400);
      const newCode = await applyNl(code, fp, lines, llm);
      return json(res, { newCode });
    }
    if (p === '/api/save' && req.method === 'POST') {
      const { path: fp, code } = await readBody(req);
      if (!fp || typeof code !== 'string') return json(res, { error: '参数缺失' }, 400);
      const full = safePath(fp);
      if (!full) return json(res, { error: '路径越界' }, 400);
      fs.writeFileSync(full, code);
      log('已保存:', fp);
      return json(res, { ok: true });
    }
    if (p === '/api/health') return json(res, { ok: true, llm: LLM.model, root: ROOT });

    // 静态
    let full;
    if (p.startsWith('/vs/')) {
      full = path.join(MONACO, 'vs', p.slice(4));
      if (!full.startsWith(MONACO)) return json(res, { error: 'not found' }, 404);
    } else {
      full = path.join(PUBLIC, p === '/' ? 'index.html' : p);
      if (!full.startsWith(PUBLIC)) return json(res, { error: 'not found' }, 404);
    }
    const data = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(data);
  } catch (e) {
    log('ERR', e.message);
    return json(res, { error: e.message }, 500);
  }
});

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  log(`NL Code Mirror MVP 启动: http://127.0.0.1:${PORT}`);
  log(`  项目根: ${ROOT}`);
  log(`  LLM: ${LLM.model} @ ${LLM.baseUrl} (env 可覆盖 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL)`);
});
