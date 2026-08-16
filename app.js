/* NL Code Mirror — 前端逻辑(逐行镜像版) */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  root: null,
  file: null,       // 相对路径
  lang: 'text',
  code: '',
  baseCode: '',     // 基线代码(打开文件/应用/保存后更新),用于高亮用户修改
  baseDesc: '',     // 基线描述(生成后更新),用于高亮用户修改
  editor: null,
  descEditor: null,
  busy: false,
  undoStack: [],
  dirty: false,     // 代码或描述已改
  exts: [],
  wrap: false,      // 自动换行
  reflowing: false,
  lastDescTrim: '', // 描述实质内容快照(忽略尾部空格,识别补空格)
  lastCodeTrim: '', // 代码实质内容快照(同上,抑制补空格触发重新生成)
  codePadLines: new Set(), // 代码侧补了空格的行号(1-based),保存/应用时清理
};

// ---------- LLM 设置 ----------
function getLLM() {
  try { return JSON.parse(localStorage.getItem('ncm-llm') || 'null') || {}; } catch { return {}; }
}
function saveLLM(cfg) {
  localStorage.setItem('ncm-llm', JSON.stringify(cfg));
  $('llm-label').textContent = `LLM: ${cfg.model || '未配置'}`;
}
function llmBody() {
  const c = getLLM();
  const body = {};
  if (c.baseUrl) body.baseUrl = c.baseUrl;
  if (c.apiKey) body.apiKey = c.apiKey;
  if (c.model) body.model = c.model;
  if (c.detailLevel != null) body.detailLevel = c.detailLevel;
  return body;
}

// ---------- 工具 ----------
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg; t.className = type; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3200);
}
async function api(path, body) {
  const opt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

// ---------- 文件树 ----------
async function loadTree() {
  const r = await fetch('/api/tree');
  const j = await r.json();
  state.root = j.root;
  $('root-label').textContent = `项目: ${j.root}`;
  renderTree(j.tree, $('tree'), 0);
}
async function openDir() {
  openDirPicker((dir) => applyRoot(dir));
}

// ---------- 目录选择器(系统式弹窗) ----------
const dirPicker = { path: null, onSelect: null };
async function openDirPicker(onSelect) {
  dirPicker.onSelect = onSelect;
  $('dir-mask').hidden = false;
  await browseDirs(state.root || '');
}
async function browseDirs(dir) {
  dirPicker.path = dir;
  const r = await fetch('/api/list-dirs?path=' + encodeURIComponent(dir));
  const j = await r.json();
  if (j.error) return toast(j.error, 'err');
  dirPicker.path = j.path;
  dirPicker.parent = j.parent;
  $('dir-path').textContent = j.path;
  const list = $('dir-list');
  list.innerHTML = '';
  if (!j.dirs.length) {
    list.innerHTML = '<div class="empty-hint">(空目录)</div>';
    return;
  }
  for (const name of j.dirs) {
    const d = document.createElement('div');
    d.className = 'ditem';
    d.innerHTML = '<span class="ico">📁</span><span>' + esc(name) + '</span>';
    d.addEventListener('click', () => browseDirs(dirPicker.path.replace(/\/+$/, '') + '/' + name));
    list.appendChild(d);
  }
}
function closeDirPicker() { $('dir-mask').hidden = true; dirPicker.onSelect = null; }
function hasSelection() { const s = window.getSelection(); return !!(s && s.toString().length > 0); }
function descTrim() { return state.descEditor.getValue().split('\n').map(l => l.trimEnd()).join('\n'); }
async function applyRoot(dir) {
  try {
    const r = await fetch('/api/set-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const j = await r.json();
    if (j.error) return toast(j.error, 'err');
    state.root = j.root;
    localStorage.setItem('ncm-dir', j.root);
    $('root-label').textContent = `项目: ${j.root}`;
    renderTree(j.tree, $('tree'), 0);
    toast('已切换到: ' + j.root, 'ok');
    return true;
  } catch (e) { toast('切换失败: ' + e.message, 'err'); return false; }
}
function renderTree(nodes, el, depth) {
  el.innerHTML = '';
  for (const n of nodes) {
    const d = document.createElement('div');
    d.className = n.dir ? 'dir' : 'file';
    if (n.dir) {
      d.innerHTML = `<span class="tw">▸</span><span class="lbl">${esc(n.name)}</span>`;
      const ch = document.createElement('div');
      ch.className = 'children'; ch.style.display = 'none';
      const lbl = d.querySelector('.lbl');
      lbl.addEventListener('click', () => {
        const open = ch.style.display !== 'none';
        ch.style.display = open ? 'none' : 'block';
        d.querySelector('.tw').textContent = open ? '▸' : '▾';
      });
      if (n.children) renderTree(n.children, ch, depth + 1);
      d.appendChild(ch);
    } else {
      d.textContent = n.name;
      d.title = n.path;
      d.addEventListener('click', () => openFile(n.path));
      if (state.file === n.path) d.classList.add('active');
    }
    el.appendChild(d);
  }
}
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 文件 ----------
async function openFile(rel) {
  state.file = rel;
  state.undoStack = [];
  state.dirty = false;
  document.querySelectorAll('#tree .file.active').forEach(e => e.classList.remove('active'));
  const j = await (await fetch('/api/file?path=' + encodeURIComponent(rel))).json();
  if (j.error) return toast(j.error, 'err');
  state.lang = j.lang || 'text';
  state.code = j.code;
  state.baseCode = j.code;
  state.lastCodeTrim = j.code.split('\n').map(l => l.trimEnd()).join('\n');
  state.codePadLines = new Set();
  const m = monaco.editor.createModel(j.code, langToMonaco(j.lang));
  state.editor.setModel(m);
  state.descEditor.setValue('');
  state.baseDesc = '';
  $('status').textContent = '';
  const ev = document.querySelector(`#tree .file[title="${CSS.escape(rel)}"]`);
  if (ev) ev.classList.add('active');
  // 加载已保存的描述;没有匹配的则留空,等用户手动点「✨ 生成描述」
  try {
    const d = await (await fetch('/api/desc?path=' + encodeURIComponent(rel))).json();
    if (d.lines && d.codeHash === j.codeHash) {
      state.descEditor.setValue(d.lines.join('\n'));
      state.baseDesc = d.lines.join('\n');
      state.lastDescTrim = descTrim();
      state.dirty = false;
      $('status').textContent = '已加载保存的描述';
        return;
    }
  } catch {}
  state.descEditor.setValue('');
  state.dirty = false;
  $('status').textContent = '点「✨ 生成描述」生成解释';
}
function langToMonaco(l) {
  const map = { js: 'javascript', ts: 'typescript', py: 'python', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby', sh: 'shell', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', lua: 'lua', php: 'php', sql: 'sql', vue: 'html' };
  return map[l] || 'plaintext';
}

// ---------- 生成描述(代码 → 逐行自然语言) ----------
let explainTimer = null;
function autoExplain() { clearTimeout(explainTimer); explainTimer = setTimeout(generateBlocks, 1600); }
async function generateBlocks() {
  if (!state.file || state.busy) return;
  const code = state.editor.getValue();
  state.code = code;
  state.busy = true; setBusy(true);
  $('status').textContent = '生成中…';
  try {
    const j = await api('/api/explain', { path: state.file, code, llm: llmBody() });
    const lines = j.lines || [];
    state.descEditor.setValue(lines.join('\n'));
    state.baseDesc = lines.join('\n');
    state.lastDescTrim = descTrim();
    state.dirty = false;
    $('status').textContent = '';
    toast(`已生成逐行描述(${lines.length} 行)`, 'ok');
  } catch (e) {
    $('status').textContent = '生成失败';
    toast('生成描述失败: ' + e.message, 'err');
  } finally { state.busy = false; setBusy(false); }
}

// ---------- 应用到代码(逐行描述 → 代码) ----------
async function applyBlocks() {
  if (!state.file) return toast('先打开一个文件', 'err');
  const code = stripCodePads();
  const lines = state.descEditor.getValue().split('\n');
  // 行数对齐(描述少补空,多截断)
  const codeLines = code.split('\n').length;
  while (lines.length < codeLines) lines.push('');
  lines.length = codeLines;
  state.busy = true; setBusy(true);
  $('status').textContent = '应用修改中…';
  try {
    const j = await api('/api/apply-nl', { path: state.file, code, lines, llm: llmBody() });
    if (!j.newCode) throw new Error('空返回');
    state.undoStack.push(code);
    state.editor.setValue(j.newCode);
    state.code = j.newCode;
    state.baseCode = j.newCode;   // AI 应用结果成为新基线,不再高亮
    state.lastCodeTrim = j.newCode.split('\n').map(l => l.trimEnd()).join('\n');
    state.codePadLines = new Set();
    state.dirty = false;
    $('status').textContent = '已应用 ✓';
    toast('已按描述修改代码(可撤销)', 'ok');
    autoExplain();
  } catch (e) {
    $('status').textContent = '应用失败';
    toast('应用失败: ' + e.message, 'err');
  } finally { state.busy = false; setBusy(false); }
}
function undoApply() {
  const prev = state.undoStack.pop();
  if (prev === undefined) return toast('没有可撤销的修改', 'err');
  state.editor.setValue(prev);
  state.code = prev;
  state.baseCode = prev;
  toast('已撤销', 'ok');
}

// ---------- 保存到文件 ----------
async function saveFile() {
  if (!state.file) return toast('先打开一个文件', 'err');
  const code = stripCodePads();
  try {
    const r = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.file, code }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    state.baseCode = code;
    state.code = code;
    state.dirty = false;
    updateEditHighlights();
    $('status').textContent = '已保存 ✓';
    toast('已保存到文件', 'ok');
  } catch (e) { toast('保存失败: ' + e.message, 'err'); }
}


// ---------- 用户修改高亮(黄色加粗,相对基线) ----------
let hlCodeDeco = null, hlDescDeco = null;
// 返回第一个不同到最后一个不同的行区间(简化 diff);无差异返回 null
function diffRange(aLines, bLines) {
  const n = Math.min(aLines.length, bLines.length);
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    if (aLines[i] !== bLines[i]) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) {
    if (aLines.length === bLines.length) return null;
    first = n; last = Math.max(aLines.length, bLines.length) - 1;
  } else if (aLines.length !== bLines.length) {
    last = Math.max(last, Math.max(aLines.length, bLines.length) - 1);
  }
  return { start: first + 1, end: last + 1 };
}
function applyHl(editor, base, current, slot) {
  if (slot) slot.clear();
  const aLines = String(base || '').split('\n').map(l => l.trimEnd());
  const bLines = String(current || '').split('\n').map(l => l.trimEnd());
  const r = diffRange(aLines, bLines);
  if (!r) return null;
  return editor.createDecorationsCollection([{
    range: new monaco.Range(r.start, 1, r.end, 1),
    options: { isWholeLine: true, className: 'user-edit', fontWeight: 'bold' },
  }]);
}
function updateEditHighlights() {
  hlCodeDeco = applyHl(state.editor, state.baseCode, state.editor.getValue(), hlCodeDeco);
  hlDescDeco = applyHl(state.descEditor, state.baseDesc, state.descEditor.getValue(), hlDescDeco);
}

// ---------- 编辑器 ----------
function initEditor() {
  self.MonacoEnvironment = {
    getWorkerUrl: () => './vs/editor/editor.worker.js',
  };
  const base = {
    theme: 'vs-dark',
    fontSize: 13,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
  };
  state.editor = monaco.editor.create($('editor'), base);
  state.descEditor = monaco.editor.create($('desc-editor'), {
    ...base,
    readOnly: false,
    language: 'plaintext',
    lineNumbers: 'on',
  });
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);

  // 同步滚动:两个编辑器行号一一对应,滚动始终对齐(行高/字号一致)
  state.editor.onDidScrollChange((e) => {
    if (Math.abs(state.descEditor.getScrollTop() - e.scrollTop) < 1) return;
    state.descEditor.setScrollTop(e.scrollTop);
  });
  state.descEditor.onDidScrollChange((e) => {
    if (Math.abs(state.editor.getScrollTop() - e.scrollTop) < 1) return;
    state.editor.setScrollTop(e.scrollTop);
  });

  // 行联动:点击一侧某行 → 另一侧同步高亮 + 跳到同一行
  state.editor.onMouseDown((e) => {
    if (!e.target || !e.target.position) return;
    setHl(e.target.position.lineNumber);
    state.descEditor.revealLineInCenter(e.target.position.lineNumber);
  });
  state.descEditor.onMouseDown((e) => {
    if (!e.target || !e.target.position) return;
    setHl(e.target.position.lineNumber);
    state.editor.revealLineInCenter(e.target.position.lineNumber);
  });
  // 描述编辑 → 标记"可应用" + 高亮用户修改(补空格触发的变化用 trim 快照识别,忽略)
  state.descEditor.onDidChangeModelContent(debounce(() => {
    if (!state.file) return;
    const t = descTrim();
    if (t === state.lastDescTrim) return;
    state.lastDescTrim = t;
    state.dirty = true;
    updateEditHighlights();
    $('status').textContent = '描述已修改,可点「▶ 应用到代码」';
  }, 600));
  // 代码编辑 → 高亮用户修改 + 自动重新生成描述(补空格触发的变化用 trim 快照识别,忽略)
  state.editor.onDidChangeModelContent(debounce(() => {
    if (!state.file) return;
    const t = state.editor.getValue().split('\n').map(l => l.trimEnd()).join('\n');
    if (t === state.lastCodeTrim) return;
    state.lastCodeTrim = t;
    state.dirty = true;
    updateEditHighlights();
    $('status').textContent = '代码已修改…';
    autoExplain();
  }, 1500));
}

function setBusy(b) { $('btn-explain').disabled = b; $('btn-apply').disabled = b; }

// 双向行高亮
let hlDeco = { code: null, desc: null };
function setHl(line) {
  if (hlDeco.code) hlDeco.code.clear();
  if (hlDeco.desc) hlDeco.desc.clear();
  if (!line) return;
  const mk = (ed) => ed.createDecorationsCollection([{
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, className: 'ncm-hl' },
  }]);
  hlDeco.code = mk(state.editor);
  hlDeco.desc = mk(state.descEditor);
}

// ---------- AI 提供商预设 ----------
const PRESETS = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'] },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'] },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat-v3.1', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash', 'qwen/qwen-2.5-72b-instruct'] },
  moonshot: { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'] },
  zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  dashscope: { name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-72b-instruct'] },
  siliconflow: { name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'] },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  ollama: { name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: [] },
};
function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  $('set-base').value = p.baseUrl;
  fillModelSelect(p.models);
  $('set-model').dataset.preset = key;
}
// 填充模型下拉(预设模型 + 自定义入口)
function fillModelSelect(models) {
  const sel = $('set-model');
  sel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') +
    `<option value="__custom__">✏️ 自定义…</option>`;
  const custom = $('set-model-custom');
  sel.onchange = () => {
    if (sel.value === '__custom__') { custom.hidden = false; custom.focus(); }
    else { custom.hidden = true; }
  };
}
function currentModel() {
  const sel = $('set-model');
  if (sel.value === '__custom__') return $('set-model-custom').value.trim();
  return sel.value;
}
function presetForUrl(url) {
  for (const [k, p] of Object.entries(PRESETS)) {
    if (url && url.replace(/\/$/, '').toLowerCase() === p.baseUrl.replace(/\/$/, '').toLowerCase()) return k;
  }
  return '';
}

// ---------- 设置弹窗 ----------
function openSettings() {
  const c = getLLM();
  const url = c.baseUrl || '';
  const presetKey = presetForUrl(url);
  $('set-preset').value = presetKey;
  const models = presetKey ? PRESETS[presetKey].models : [];
  fillModelSelect(models);
  const model = c.model || '';
  const sel = $('set-model');
  const custom = $('set-model-custom');
  if (models.includes(model)) { sel.value = model; custom.hidden = true; }
  else if (model) { sel.value = '__custom__'; custom.hidden = false; custom.value = model; }
  else { sel.value = models[0] || '__custom__'; custom.hidden = sel.value === '__custom__'; }
  if (presetKey) $('set-base').value = PRESETS[presetKey].baseUrl;
  $('set-base').value = url || 'http://127.0.0.1:11434/v1';
  $('set-key').value = c.apiKey || '';
  $('set-dir').value = state.root || '';
  $('set-detail').value = c.detailLevel != null ? c.detailLevel : 40;
  $('set-exts').value = (state.exts || []).join(', ');
  updateDetailTag();
  $('modal-mask').hidden = false;
}
function updateDetailTag() {
  const v = +$('set-detail').value;
  const tag = v < 30 ? '极简' : v < 70 ? '标准' : '详细';
  $('set-detail-val').textContent = `${v} (${tag})`;
}
function closeSettings() { $('modal-mask').hidden = true; }

// ---------- 启动(AMD 加载 Monaco 完成后) ----------
window.__nlcmStart = async () => {
  initEditor();
  $('btn-refresh').addEventListener('click', loadTree);
  $('btn-open-dir').addEventListener('click', openDir);
  $('btn-explain').addEventListener('click', generateBlocks);
  $('btn-apply').addEventListener('click', applyBlocks);
  $('btn-undo').addEventListener('click', undoApply);
  $('btn-save-file').addEventListener('click', saveFile);
  $('btn-settings').addEventListener('click', openSettings);
  // 目录选择器按钮
  $('dir-up').addEventListener('click', () => browseDirs(dirPicker.parent));
  $('dir-home').addEventListener('click', () => browseDirs(''));
  $('dir-cancel').addEventListener('click', closeDirPicker);
  $('dir-select').addEventListener('click', () => {
    const cb = dirPicker.onSelect;
    const p = dirPicker.path;
    closeDirPicker();
    if (cb && p) cb(p);
  });
  $('dir-mask').addEventListener('mouseup', (e) => {
    if (e.target === $('dir-mask') && !hasSelection()) closeDirPicker();
  });
  $('btn-browse').addEventListener('click', () => openDirPicker((dir) => { $('set-dir').value = dir; }));
  $('set-preset').addEventListener('change', () => applyPreset($('set-preset').value));
  $('set-detail').addEventListener('input', updateDetailTag);
  $('btn-save').addEventListener('click', async () => {
    saveLLM({ baseUrl: $('set-base').value.trim(), apiKey: $('set-key').value.trim(), model: currentModel(), detailLevel: +$('set-detail').value });
    // 保存自定义扩展名
    const exts = $('set-exts').value.split(/[,，\s]+/).filter(Boolean);
    try {
      const r = await fetch('/api/exts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exts }),
      });
      const j = await r.json();
      state.exts = j.exts || [];
    } catch {}
    closeSettings();
    const dir = $('set-dir').value.trim();
    if (dir && dir !== state.root) await applyRoot(dir);
    toast('设置已保存', 'ok');
  });
  $('btn-cancel').addEventListener('click', closeSettings);
  // 点击遮罩关闭:鼠标松开点在遮罩上且没有选中文本才关闭(拖选文字复制不误关)
  $('modal-mask').addEventListener('mouseup', (e) => {
    if (e.target === $('modal-mask') && !hasSelection()) closeSettings();
  });
  const c = getLLM();
  $('llm-label').textContent = `LLM: ${c.model || '未配置(默认本地 ollama)'}`;
  // 加载自定义扩展名
  try { state.exts = (await (await fetch('/api/exts')).json()).exts || []; } catch { state.exts = []; }
  try { await loadTree(); } catch (e) { toast('加载项目失败: ' + e.message, 'err'); }
  // 启动:恢复上次工作目录;首次使用则引导设置
  const savedDir = localStorage.getItem('ncm-dir');
  if (savedDir) {
    await applyRoot(savedDir);
  } else {
    setTimeout(() => {
      openDirPicker(async (dir) => { if (await applyRoot(dir)) { toast('默认工作目录已设置: ' + dir, 'ok'); } });
    }, 400);
  }
};
require(['vs/editor/editor.main'], function () { window.__nlcmStart(); });

// 行高亮样式
const style = document.createElement('style');
style.textContent = '.ncm-hl { background: #3b5bdb55; } .user-edit { background: #ffd70044; }';
document.head.appendChild(style);
