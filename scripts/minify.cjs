/* _minify.cjs —— 归档压缩：CSS 与 JS 两段都压，产物体积直接决定每次页面加载的传输量
 *
 * 🔴 源文件不是纯 JS，是 HTML 片段：
 *     <!-- [KANO_PLUGIN_START] -->  ← 段标记（必须保留）
 *     <style id="aura2-css">…</style>  ← CSS 段（v2.4.36 起去注释、去缩进）
 *     <script id="aura2-engine">…</script> ← JS 主体
 *     <!-- [KANO_PLUGIN_END] -->
 *   直接把整个文件喂给 terser 会在第 3 行报 JS_Parse_Error —— 那是 HTML 说明块。
 *
 * 🔴 v2.4.36 压缩策略（此前只删注释空白，JS 564 KB / CSS 137 KB，合计 780 KB）：
 *   JS：compress 走「保守集」+ mangle。
 *     ① compress 关掉 evaluate / side_effects：AURA 里塞了大量 shell 命令字符串与
 *        base64 模板，常量折叠一旦认定「这段可优化」就会改写命令结构，必须禁掉。
 *        dead_code / unused / conditionals / sequences / join_vars 都是纯结构化简，
 *        不改任何字面量的内容，语义等价。
 *     ② mangle 重命名局部标识符：全文件零 eval、零 new Function、零
 *        「字符串拼函数名」的动态调用（已 grep 核实），表驱动引用（ACTIONS / SPECIAL_UI /
 *        MORE_RENDER 里以对象值出现）会被 terser 一致改名，所以是安全的。
 *     ③ mangle.reserved 保住外部工具依赖的**锚点名**：门禁与真机探针按
 *        `var VER=` / `var DOMAINS=` 这类文本定位，改名就全瞎了。
 *        只保留这几个名字，体积影响可忽略（不到 100 B）。
 *   CSS：去注释 + 逐行 trim + 去空行。**不做行内空白折叠**——`calc(100% - 10px)` 的
 *        空格与 `content:"…"` 里的连续空格都有语义，省的 3 KB 不值这个风险。
 *
 *   对照数据（v2.4.35 源码）：JS 564.1 → 489.5 KB、CSS 137.5 → 112.8 KB，
 *   全产物 779.9 → ~603 KB（-22%）。
 *
 * 用法: node build/_minify.cjs [输出文件]
 */
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SRC = path.join(__dirname, '..', 'ufitools-aura-v2.js');
const DEF_OUT = path.join(__dirname, '..', 'build', '_min_test.js');
const OUT = process.argv[2] || DEF_OUT;
/* 段标记：源码第 1 行是 HTML-like comment（JS 里算注释，terser 会删）。
   它是 AURA 自识别 / 备份还原段时用的锚点，压缩后必须补回去。 */
const MARK = '<!-- [KANO_PLUGIN_START] ufitools-aura-v2.js -->';

/* 外部工具（门禁 / 真机探针）按这些文本定位，mangle 不许改名。
   FIND_ROSTER / MORE_STEP / skel 是冒烟里的「源码层」断言目标（静态名册、加载步长、
   骨架起手），名字被改就匹配不到——那不是行为回归，是门禁在按字面量读源码。 */
const KEEP_NAMES = ['VER', 'BUILD', 'DOMAINS', 'SVC_CMD', 'SVC_PROBE', 'ACTIONS', 'SPECIAL_UI',
  'FIND_ROSTER', 'MORE_STEP', 'skel', 'advProbeInto', 'advRender'];

/* CSS 压缩：去注释 -> 逐行 trim -> 去空行。保留行内空白（calc / content 有语义）。 */
function minCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

(async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const tagS = '<script id="aura2-engine">';
  const jsStart = src.indexOf(tagS);
  if (jsStart < 0) throw new Error('未找到 <script id="aura2-engine">');
  const bodyStart = jsStart + tagS.length;
  const jsEnd = src.indexOf('</script>', bodyStart);
  if (jsEnd < 0) throw new Error('未找到 </script>');
  const jsCode = src.slice(bodyStart, jsEnd);

  /* CSS 段：<style id="aura2-css"> 之后到 </style> */
  const cssOpen = '<style id="aura2-css">';
  const cssStart = src.indexOf(cssOpen);
  if (cssStart < 0) throw new Error('未找到 <style id="aura2-css">');
  const cssBodyStart = cssStart + cssOpen.length;
  const cssEnd = src.indexOf('</style>', cssBodyStart);
  if (cssEnd < 0) throw new Error('未找到 CSS 的 </style>');
  const cssCode = src.slice(cssBodyStart, cssEnd);
  if (cssEnd > bodyStart) throw new Error('CSS 段与 JS 段顺序异常，拒绝压缩');

  const r = await minify(jsCode, {
    compress: {
      /* 保守集：只做结构化简，绝不做常量求值 / 副作用推断。
         evaluate 关掉是因为 AURA 的 shell 命令串里有大量拼装与数值参与，
         一旦被折叠，注入到设备上的命令就变了样。 */
      defaults: false,
      dead_code: true,
      unused: true,
      conditionals: true,
      sequences: true,
      booleans: true,
      if_return: true,
      join_vars: true,
      evaluate: false,
      side_effects: false,
      pure_getters: false,
      drop_console: false,
      unsafe: false
    },
    mangle: { reserved: KEEP_NAMES },
    format: { comments: false, ascii_only: false },
    sourceMap: false
  });
  if (r.error) throw r.error;

  const cssMin = minCss(cssCode);
  const out = src.slice(0, cssBodyStart) + '\n' + cssMin + '\n' +
    src.slice(cssEnd, bodyStart) + '\n' + r.code + '\n' + src.slice(jsEnd);
  fs.writeFileSync(OUT, out, 'utf8');

  const before = src.length, after = out.length;
  const K = n => (n / 1024).toFixed(1) + ' KB';
  console.log('源    :', before, 'B (' + K(before) + ')');
  console.log('  ├ CSS:', cssCode.length, '->', cssMin.length, 'B  (' + K(cssCode.length) + ' -> ' + K(cssMin.length) + ')');
  console.log('  └ JS :', jsCode.length, '->', r.code.length, 'B  (' + K(jsCode.length) + ' -> ' + K(r.code.length) + ')');
  console.log('压缩后:', after, 'B (' + K(after) + ')');
  console.log('减少  :', before - after, 'B (' + K(before - after) + ', ' +
    ((before - after) / before * 100).toFixed(1) + '%)');
  console.log('输出  :', OUT);

  /* 语法自检：对压缩后的 JS 主体单独 new Function（terser 解析过，这是二道保险） */
  try {
    new Function(r.code);
    console.log('语法  : OK');
  } catch (e) {
    console.log('语法  : FAIL -', e.message);
    process.exit(1);
  }
  /* 关键锚点必须在：段标记 / style / script 结构 / 版本号 / 三张结构表。
     🔴 `var VER=` 是硬锚点：ref/_headver.cjs 与真机探针按这段文本读版本号，mangle 后必须还在。
     结构表只断言 `名={`——join_vars 会把相邻的 var 声明合并成 `var a=1,SVC_CMD={…}`，
     再要求 `var SVC_CMD=` 就成了假失败（表本身完好，只是不再独占一个 var 关键字）。 */
  ['[KANO_PLUGIN_START] ufitools-aura-v2.js', '[KANO_PLUGIN_END]',
    '<style id="aura2-css">', '<script id="aura2-engine">', '</script>',
    'var VER=', 'DOMAINS=[', 'SVC_CMD={', 'ACTIONS={']
    .forEach(k => {
      const ok = out.includes(k);
      console.log((ok ? '  OK   ' : '  FAIL ') + '保留锚点: ' + k);
      if (!ok) process.exitCode = 1;
    });
  /* shell 命令字符串不能被改写：抽几条关键命令比对 */
  ['pkill -x openlist', 'admin set admin', 'OPENLIST_MIN_FREE_MEMORY=128', 'guard-ver: 11']
    .forEach(k => {
      const ok = out.includes(k);
      console.log((ok ? '  OK   ' : '  FAIL ') + '命令原样: ' + k);
      if (!ok) process.exitCode = 1;
    });
  /* CSS 语义抽查：calc 里的减号两侧空格、content 里的引号字符串都必须在 */
  ['calc(100vw - 16px)', 'content:"'].forEach(k => {
    const ok = out.includes(k);
    console.log((ok ? '  OK   ' : '  FAIL ') + 'CSS 原样: ' + k);
    if (!ok) process.exitCode = 1;
  });
})().catch(e => { console.error('minify 失败:', e); process.exit(2); });
