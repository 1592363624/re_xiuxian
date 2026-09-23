<template>
  <!--
    后台日志查看器（GM 后台「后台日志」页）
    把后端进程的控制台输出搬到网页上：不必再 SSH 上机 tail -f，
    手机/平板排障时也能直接看。输出按类型着色（时间/级别/链接/路径/标签/数字），
    错误行整体加底色，扫一眼就能定位。
  -->
  <div class="space-y-3">
    <!-- 标题与说明 -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-lg font-bold text-fg-primary">后台日志</h3>
        <p class="mt-1 text-xs text-fg-faint">
          服务器控制台输出（PM2 / tee 采集的日志文件）。支持级别筛选、关键词搜索与实时跟随；<span class="text-fg-muted">本页只读，不会修改或清空服务器上的日志文件</span>。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <!-- 实时状态灯：跟随中 / 已暂停 -->
        <span
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded-control border text-xs"
          :class="autoRefresh
            ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300'
            : 'border-line bg-surface-hover text-fg-muted'"
        >
          <span class="w-1.5 h-1.5 rounded-full" :class="autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-fg-faint'"></span>
          {{ autoRefresh ? '实时跟随中' : '已暂停' }}
        </span>
        <span v-if="!wrapLines" class="hidden sm:inline text-xs text-fg-faint">长行可横向滚动查看</span>
      </div>
    </div>

    <!-- 工具栏：筛选条件 + 视图控制 -->
    <div class="flex flex-wrap items-center gap-2 bg-surface-base/50 rounded-panel border border-line p-3">
      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-muted">日志源</label>
        <select
          v-model="sourceId"
          @change="reloadSnapshot"
          :disabled="readableSources.length === 0"
          class="max-w-56 bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600 disabled:opacity-40"
        >
          <option v-for="src in readableSources" :key="src.id" :value="src.id">{{ src.name }}</option>
        </select>
      </div>

      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-muted">级别</label>
        <select
          v-model="level"
          @change="reloadSnapshot"
          class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600"
        >
          <option v-for="item in levels" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </div>

      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-muted">最新</label>
        <select
          v-model.number="linesLimit"
          @change="reloadSnapshot"
          class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600"
        >
          <option v-for="n in lineOptions" :key="n" :value="n">{{ n }} 行</option>
        </select>
      </div>

      <div class="flex items-center gap-2">
        <input
          v-model="keywordInput"
          @keyup.enter="applyKeyword"
          type="text"
          :maxlength="maxKeywordLength"
          placeholder="搜索日志内容（不区分大小写）"
          class="w-56 bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600"
        />
        <AppButton variant="primary" size="xs" @click="applyKeyword">查询</AppButton>
        <AppButton variant="default" size="xs" @click="resetFilters">重置</AppButton>
      </div>

      <!-- 视图控制放右侧 -->
      <div class="flex flex-wrap items-center gap-2 ml-auto">
        <AppButton
          :variant="wrapLines ? 'primary' : 'default'"
          size="xs"
          title="长行是否自动换行显示"
          @click="toggleWrap"
        >自动换行</AppButton>
        <AppButton
          :variant="autoScroll ? 'primary' : 'default'"
          size="xs"
          title="有新日志时自动滚到底部"
          @click="toggleAutoScroll"
        >自动滚动</AppButton>
        <AppButton
          :variant="autoRefresh ? 'primary' : 'default'"
          size="xs"
          title="按下面间隔持续拉取新增日志"
          @click="toggleAutoRefresh"
        >{{ autoRefresh ? '暂停跟随' : '实时跟随' }}</AppButton>
        <select
          v-model.number="liveInterval"
          :disabled="!autoRefresh"
          @change="restartAutoRefresh"
          class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600 disabled:opacity-40"
        >
          <option v-for="ms in intervalOptions" :key="ms" :value="ms">{{ ms / 1000 }} 秒</option>
        </select>
        <select
          v-model.number="fontSizePx"
          @change="persistFontSize"
          title="终端输出字号"
          class="bg-surface-sunken border border-line rounded-control px-2 py-1 text-sm text-fg-secondary focus-ring focus:border-gold-600"
        >
          <option v-for="px in fontOptionsPx" :key="px" :value="px">字号 {{ px }}</option>
        </select>
        <AppButton variant="default" size="xs" :loading="loading" @click="reloadSnapshot">刷新</AppButton>
        <AppButton variant="default" size="xs" @click="copyAll">复制</AppButton>
        <AppButton variant="default" size="xs" title="只清空当前页面显示，不影响服务器日志文件" @click="clearView">清空视图</AppButton>
      </div>
    </div>

    <!-- 终端输出区 -->
    <div
      ref="terminalRef"
      class="h-[calc(100vh-340px)] min-h-[320px] overflow-auto scroll-thin rounded-panel border border-line-strong bg-surface-sunken p-2 font-mono"
      :class="wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'"
      :style="terminalTextStyle"
    >
      <!-- 首次加载 -->
      <div v-if="loading && lines.length === 0" class="p-3 text-fg-muted">正在读取日志...</div>

      <!-- 无任何可读日志文件 -->
      <div v-else-if="!hasReadableSource" class="p-3 text-fg-faint">
        当前没有可读的日志文件。已登记的日志源见下方列表，等待服务写日志或按需调整
        <span class="font-mono">config/system_log_viewer.json</span> 的 sources。
      </div>

      <!-- 空状态：区分"文件不存在"与"过滤后无结果" -->
      <div v-else-if="lines.length === 0 && !pending" class="p-3 text-fg-faint">没有匹配的日志内容</div>

      <template v-else>
        <div
          v-for="line in lines"
          :key="line.id"
          class="px-1 rounded-sm"
          :class="lineRowClass(line.level)"
        >
          <!-- 按分词结果逐段着色：级别判定来自服务端，颜色映射来自前端主题 -->
          <span :class="levelTextClass(line.level)"><span
            v-for="(seg, segIndex) in line.segments"
            :key="segIndex"
            :class="kindClass(seg.kind)"
          >{{ seg.text }}</span></span>
        </div>
        <!-- 临时行：末行尚未以换行结尾（可能正在写入），下次轮询会被完整行替换 -->
        <div v-if="showPending" class="px-1 rounded-sm text-fg-faint italic">
          {{ pending }} <span class="not-italic">… 未结束的行</span>
        </div>
      </template>
    </div>

    <!-- 状态栏 -->
    <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-faint">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>文件：<span class="text-fg-muted font-mono">{{ currentSourceFile || '-' }}</span></span>
        <span>体积：<span class="text-fg-muted num">{{ formatSize(fileSize) }}</span></span>
        <span>显示：<span class="text-fg-muted num">{{ lines.length }}</span> 行<span v-if="pending"> +1 临时行</span></span>
        <span>文件更新：<span class="text-fg-muted num">{{ formattedModifiedAt }}</span></span>
        <span>上次刷新：<span class="text-fg-muted num">{{ lastRefreshText }}</span></span>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <span v-if="rotated" class="text-amber-400">日志文件已被轮转/清空，已自动从头跟随</span>
        <span v-else-if="truncated" class="text-amber-400">命中行数超过显示上限，仅展示最新 {{ lines.length }} 行</span>
        <span v-if="errorMessage" class="text-rose-400">{{ errorMessage }}</span>
      </div>
    </div>

    <!-- 错误日志告警状态 + 测试按钮 -->
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-surface-base/50 p-3">
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <span class="text-sm text-fg-secondary">错误日志告警（飞书）</span>
          <span class="px-1.5 py-0.5 rounded border text-[11px]" :class="alertBadgeClass">{{ alertStateText }}</span>
        </div>
        <div class="text-xs text-fg-faint">{{ alertDetailText }}</div>
      </div>
      <AppButton variant="default" size="xs" :loading="testingAlert" @click="sendTestAlert">发送测试告警</AppButton>
    </div>

    <!-- 日志源说明：文件不存在的不再列出（避免噪音），配置写错的仍然列出以便修正 -->
    <div v-if="visibleSourceDescriptions.length > 0" class="text-xs text-fg-faint space-y-0.5">
      <div v-for="src in visibleSourceDescriptions" :key="`desc-${src.id}`">
        <span class="text-fg-muted">{{ src.name }}</span>
        <span class="font-mono">（{{ src.file }}）</span>
        <span v-if="src.description">：{{ src.description }}</span>
        <span v-if="src.misconfigured && src.error" class="text-rose-400"> · 配置有误：{{ src.error }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台日志查看器
 *
 * 功能：
 *   1. 读取服务器落盘的日志文件（日志源白名单由后端 config/system_log_viewer.json 决定）
 *   2. 尾部快照：按行数 + 级别 + 关键词抓取最近内容
 *   3. 实时跟随：按 offset 增量轮询，只拉新增行，不重复读整个文件
 *   4. 彩色输出：按服务端下发的分词规则把每行拆成片段（时间/级别/链接/路径/标签/数字），
 *      再映射成主题颜色；规则改配置即可，不用动这份代码
 *   5. 错误日志飞书告警状态展示 + 一键发送测试告警
 *
 * 数据来源：
 *   GET  /api/admin/system-logs/sources
 *   GET  /api/admin/system-logs/tail
 *   POST /api/admin/system-logs/alert/test
 *
 * 过滤一律由后端完成：前端不再对已加载的行做二次筛选，
 * 否则"改一次筛选条件"就要等全量重拉，且前后端两套匹配规则迟早会漂移。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatBeijing } from '../../../utils/time';
import {
  getSystemLogSources,
  tailSystemLogs,
  testSystemLogAlert,
  type SystemLogHighlightRule,
  type SystemLogSourceInfo
} from '../../../api/admin';
import { LOG_CONSOLE_CONFIG } from '../../../config';
import { useUIStore } from '../../../stores/ui';
import AppButton from '../../ui/AppButton.vue';

/** 一段着色后的文本 */
interface LogSegment {
  kind: string;
  text: string;
}

/** 缓冲区内的一行 */
interface LogLine {
  id: number;
  level: string;
  text: string;
  segments: LogSegment[];
}

const uiStore = useUIStore();

/** 终端容器：自动滚动时需要它 */
const terminalRef = ref<HTMLElement | null>(null);

/** 后端下发的选项（阈值/间隔都来自配置文件，前端不写死） */
const sources = ref<SystemLogSourceInfo[]>([]);
const lineOptions = ref<number[]>([200]);
// 级别选项（含中文名）由后端配置下发，前端不再维护"键→中文名"的字典
const levels = ref<Array<{ value: string; label: string }>>([]);
const intervalOptions = ref<number[]>([5000]);
const maxBufferLines = ref(5000);
/** 关键词长度上限：与后端校验保持一致，避免用户输入超长串被后端截断却看不到原因 */
const maxKeywordLength = ref(100);
/** 错误日志告警状态（未获取到前为 null，界面上显示"未知"） */
const alertInfo = ref<{
  enabled: boolean;
  levels: string[];
  sources: string[];
  webhook_configured: boolean;
  poll_interval_ms: number;
  dedupe_window_ms: number;
} | null>(null);

/** 筛选条件 */
const sourceId = ref('');
const level = ref('all');
const linesLimit = ref(200);
const keywordInput = ref('');
const keyword = ref('');

/** 视图开关 */
const autoRefresh = ref(false);
const autoScroll = ref(true);
const wrapLines = ref(false);
const liveInterval = ref(5000);
const testingAlert = ref(false);

/**
 * 读取本地保存的字号
 * 只接受配置里仍在的档位：档位调整后，旧存档不会把字号带到一个不存在的选项上
 */
function loadFontSize(): number {
  try {
    const saved = Number(localStorage.getItem(LOG_CONSOLE_CONFIG.storageKey));
    if (LOG_CONSOLE_CONFIG.optionsPx.includes(saved)) return saved;
  } catch (e) {
    // 隐私模式/超额时 localStorage 会抛错，按默认档位继续
  }
  return LOG_CONSOLE_CONFIG.defaultPx;
}

/** 终端字号（可选档位与默认档位来自前端配置中心） */
const fontOptionsPx = LOG_CONSOLE_CONFIG.optionsPx;
const fontSizePx = ref(loadFontSize());

/** 字号 + 行高：行高随字号一起放大，否则大字号下相邻行会挤在一起 */
const terminalTextStyle = computed(() => ({
  fontSize: `${fontSizePx.value}px`,
  lineHeight: `${Math.round(fontSizePx.value * LOG_CONSOLE_CONFIG.lineHeightRatio)}px`
}));

/** 日志缓冲区（服务器已过滤） */
const lines = ref<LogLine[]>([]);
const pending = ref('');
const offset = ref(0);
const fileSize = ref(0);
const modifiedAt = ref('');
const rotated = ref(false);
const truncated = ref(false);

/** 交互状态 */
const loading = ref(false);
const errorMessage = ref('');
const lastRefreshAt = ref('');

/** 自增 id：Vue 列表 key 用它，避免用下标导致的节点复用错乱 */
let lineSeq = 0;
/** 轮询定时器句柄 */
let timer: ReturnType<typeof setInterval> | null = null;
/** 编译后的分词规则（服务端下发规则文本，前端编译一次复用） */
let compiledRules: Array<{ kind: string; regex: RegExp }> = [];

/** 当前可读的日志源：文件不存在的直接不展示，避免下拉里全是选不动的项 */
const readableSources = computed(() => sources.value.filter((s) => s.exists));
const hasReadableSource = computed(() => readableSources.value.length > 0);

/**
 * 说明区可见的日志源：可读的 + 配置写错的
 * 文件还没生成（ENOENT）属于正常状态，不占位置；配置写错必须露出来让人去修
 */
const visibleSourceDescriptions = computed(() =>
  sources.value.filter((src) => src.exists || src.misconfigured)
);

/** 当前日志源信息 */
const currentSource = computed(() => readableSources.value.find((s) => s.id === sourceId.value) || null);
const currentSourceFile = computed(() => currentSource.value?.file || '');

/**
 * 临时行是否展示
 * 有关键词/级别筛选时隐藏：那半行是否命中过滤条件未知，展示出来反而让人误以为漏了过滤
 */
const showPending = computed(() => !!pending.value && !keyword.value && level.value === 'all');

const formattedModifiedAt = computed(() => {
  if (!modifiedAt.value) return '-';
  return formatBeijing(modifiedAt.value, { fallback: '-' });
});

const lastRefreshText = computed(() => (lastRefreshAt.value ? formatBeijing(lastRefreshAt.value, { fallback: '-' }) : '-'));

/** 告警状态文案（三级：运行中 / 未配置 webhook / 已关闭） */
const alertStateText = computed(() => {
  const alert = alertInfo.value;
  if (!alert) return '状态未知';
  if (!alert.enabled) return '已关闭';
  return alert.webhook_configured ? '运行中' : '未配置 webhook';
});

const alertBadgeClass = computed(() => {
  const alert = alertInfo.value;
  if (!alert) return 'border-line bg-surface-hover text-fg-muted';
  if (!alert.enabled) return 'border-line bg-surface-hover text-fg-muted';
  return alert.webhook_configured
    ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300'
    : 'border-amber-700/60 bg-amber-950/30 text-amber-300';
});

/**
 * 告警说明：级别名与日志源名都取自服务端下发数据，前端不重复维护一份中文表
 */
const alertDetailText = computed(() => {
  const alert = alertInfo.value;
  if (!alert) return '正在读取告警配置...';
  if (!alert.enabled) return '已通过 config/system_log_viewer.json 的 alert.enabled 关闭，错误日志不会推送到飞书。';

  const levelNames = alert.levels.map((value) => levelLabelOf(value)).join(' / ') || '-';
  const sourceNames = alert.sources.map((id) => sourceNameOf(id)).join('、') || '-';
  const seconds = Math.round((alert.poll_interval_ms || 0) / 1000);
  const dedupeMinutes = Math.round((alert.dedupe_window_ms || 0) / 60000);
  const webhookHint = alert.webhook_configured
    ? ''
    : '（未配置 webhook：请设置环境变量 FEISHU_LOG_ALERT_WEBHOOK）';
  return `监控级别：${levelNames} · 日志源：${sourceNames} · 每 ${seconds} 秒检查一次 · 相同错误 ${dedupeMinutes} 分钟内只提醒一次${webhookHint}`;
});

/**
 * 级别键 → 服务端下发的显示名
 */
function levelLabelOf(value: string): string {
  return levels.value.find((item) => item.value === value)?.label || value;
}

/**
 * 日志源 id → 服务端下发的名称
 */
function sourceNameOf(id: string): string {
  return sources.value.find((item) => item.id === id)?.name || id;
}

/**
 * 编译分词规则（服务端下发规则文本）
 * 坏正则只跳过并告警：一条规则写错不该让整页日志变成纯白文字
 */
function compileHighlightRules(rules: SystemLogHighlightRule[]) {
  compiledRules = [];
  for (const rule of rules || []) {
    try {
      // 强制带 g：下面用 exec 循环扫全文，少了 g 会变成死循环
      const declared = rule.flags || 'g';
      const flags = declared.includes('g') ? declared : `${declared}g`;
      compiledRules.push({ kind: rule.kind, regex: new RegExp(rule.pattern, flags) });
    } catch (err) {
      console.warn('[SystemLogViewer] 分词规则无效:', rule, err);
    }
  }
}

/**
 * 把一行日志按规则拆成着色片段
 *
 * 算法：按规则顺序扫描，先命中的字符区间被"锁定"，后面的规则不再覆盖 ——
 * 所以"时间"必须排在"数字"前面，否则时间里的数字会先被数字规则吃掉。
 * 逐字符记录 kind 后再合并相邻同 kind 的区间，避免一行产生几十个碎片。
 * @param text - 原始行
 * @returns 片段数组（kind 为 'text' 表示不着色，继承行级别颜色）
 */
function tokenize(text: string): LogSegment[] {
  if (!text) return [];
  if (compiledRules.length === 0) return [{ kind: 'text', text }];

  const kinds: Array<string | null> = new Array(text.length).fill(null);
  for (const rule of compiledRules) {
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null = rule.regex.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (match[0].length === 0) {
        // 零宽匹配会卡死循环，手动推进一位
        rule.regex.lastIndex = start + 1;
      } else {
        let free = true;
        for (let i = start; i < end; i += 1) {
          if (kinds[i] !== null) {
            free = false;
            break;
          }
        }
        if (free) {
          for (let i = start; i < end; i += 1) kinds[i] = rule.kind;
        }
      }
      match = rule.regex.exec(text);
    }
  }

  const segments: LogSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const kind = kinds[cursor] ?? 'text';
    let end = cursor;
    while (end < text.length && (kinds[end] ?? 'text') === kind) end += 1;
    segments.push({ kind, text: text.slice(cursor, end) });
    cursor = end;
  }
  return segments;
}

/**
 * 片段类型 → 颜色
 * 服务端只说"这串字符是什么"（时间/链接/路径…），用什么颜色是前端主题的事
 */
function kindClass(kind: string): string {
  switch (kind) {
    case 'error':
      return 'text-rose-400 font-semibold';
    case 'warn':
      return 'text-amber-300';
    case 'success':
      return 'text-emerald-400';
    case 'url':
      return 'text-sky-400 underline decoration-dotted';
    case 'path':
      return 'text-teal-300';
    case 'tag':
      return 'text-cyan-300';
    case 'time':
    case 'prefix':
      return 'text-fg-faint';
    case 'number':
      return 'text-violet-300';
    case 'key':
      return 'text-gold-400';
    default:
      return '';
  }
}

/**
 * 级别 → 文本颜色（未被分词规则覆盖的部分继承这个颜色）
 */
function levelTextClass(lv: string): string {
  switch (lv) {
    case 'error':
      return 'text-rose-300';
    case 'warn':
      return 'text-amber-200';
    case 'debug':
      return 'text-fg-faint';
    default:
      return 'text-fg-secondary';
  }
}

/**
 * 级别 → 整行底色（错误行加一层淡红，概览时一眼能挑出来）
 */
function lineRowClass(lv: string): string {
  return lv === 'error' ? 'bg-rose-950/25' : '';
}

/**
 * 字节数格式化
 */
function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * 追加日志行并裁剪缓冲区
 * 分词在入队时做一次并缓存在行对象上：5 秒一轮的追加不会重复解析已有的上千行
 * @param incoming - 后端返回的新增行
 */
function appendLines(incoming: Array<{ level: string; text: string }>) {
  for (const item of incoming) {
    lines.value.push({
      id: ++lineSeq,
      level: item.level,
      text: item.text,
      segments: tokenize(item.text)
    });
  }
  // 缓冲区封顶：长时间挂在"实时跟随"上时不能把浏览器内存吃光
  if (lines.value.length > maxBufferLines.value) {
    lines.value.splice(0, lines.value.length - maxBufferLines.value);
  }
}

/**
 * 滚动到底部（仅在用户开启自动滚动时）
 */
async function scrollToBottom() {
  if (!autoScroll.value) return;
  await nextTick();
  const el = terminalRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/**
 * 加载日志源与选项（进入页面时执行一次）
 */
async function loadOptions() {
  try {
    const res = await getSystemLogSources();
    const data = res.data?.data;
    if (!data) return;

    sources.value = data.sources || [];
    lineOptions.value = data.line_options?.length ? data.line_options : lineOptions.value;
    levels.value = data.levels?.length ? data.levels : levels.value;
    intervalOptions.value = data.refresh_interval_options_ms?.length
      ? data.refresh_interval_options_ms
      : intervalOptions.value;
    maxBufferLines.value = data.max_buffer_lines || maxBufferLines.value;
    maxKeywordLength.value = data.max_keyword_length || maxKeywordLength.value;
    linesLimit.value = data.tail_default_lines || linesLimit.value;
    liveInterval.value = data.refresh_default_interval_ms || liveInterval.value;
    alertInfo.value = data.alert || null;
    compileHighlightRules(data.highlight_rules || []);

    // 默认挑第一个"文件已存在"的源：PM2 没写过 error.log 时不要让页面开在空文件上
    const available = sources.value.filter((s) => s.exists);
    if (!sourceId.value || !available.some((s) => s.id === sourceId.value)) {
      sourceId.value = available[0]?.id || '';
    }
  } catch (err: any) {
    errorMessage.value = uiStore.showApiError(err, '获取日志源失败');
  }
}

/**
 * 尾部快照：按当前筛选条件重拉
 * 同时把 offset 对齐到服务器给出的位置，实时跟随从这一刻开始接续
 */
async function reloadSnapshot() {
  if (!sourceId.value) return;
  loading.value = true;
  errorMessage.value = '';
  try {
    const res = await tailSystemLogs({
      source: sourceId.value,
      lines: linesLimit.value,
      level: level.value,
      keyword: keyword.value
    });
    const data = res.data?.data;
    if (!data) return;

    // 快照是"替换"语义，所以这里整体重置缓冲
    lineSeq = 0;
    lines.value = [];
    appendLines(data.lines || []);

    pending.value = data.pending || '';
    offset.value = data.offset;
    fileSize.value = data.size;
    modifiedAt.value = data.modified_at;
    rotated.value = false;
    truncated.value = !!data.truncated;
    lastRefreshAt.value = new Date().toISOString();
    await scrollToBottom();
  } catch (err: any) {
    errorMessage.value = uiStore.showApiError(err, '读取日志失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 增量拉取：只取 offset 之后的新增内容并追加
 * 出错的常见原因是服务重启导致文件被替换，此时提示但不打断轮询
 */
async function fetchIncrement() {
  if (!sourceId.value) return;
  try {
    const res = await tailSystemLogs({
      source: sourceId.value,
      lines: linesLimit.value,
      level: level.value,
      keyword: keyword.value,
      offset: offset.value
    });
    const data = res.data?.data;
    if (!data) return;

    appendLines(data.lines || []);
    pending.value = data.pending || '';
    offset.value = data.offset;
    fileSize.value = data.size;
    modifiedAt.value = data.modified_at;
    rotated.value = !!data.rotated;
    lastRefreshAt.value = new Date().toISOString();
    errorMessage.value = '';
    await scrollToBottom();
  } catch (err: any) {
    errorMessage.value = uiStore.showApiError(err, '实时拉取日志失败');
    // 拉取失败就停下来，避免在服务异常时对着一个坏接口每几秒打一次
    stopAutoRefresh();
  }
}

/**
 * 启动轮询
 */
function startAutoRefresh() {
  stopAutoRefresh();
  timer = setInterval(fetchIncrement, liveInterval.value);
}

/**
 * 停止轮询
 */
function stopAutoRefresh() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 切换实时跟随
 * 开启时先补一次快照：否则 offset 还停在很早的位置，会一次性冲出几千行
 */
async function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    await reloadSnapshot();
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

/**
 * 轮询间隔变更后按新间隔重启（未开启跟随时只记值）
 */
function restartAutoRefresh() {
  if (autoRefresh.value) startAutoRefresh();
}

/**
 * 应用关键词（回车或点查询）：筛选在后端，必须重拉快照
 */
function applyKeyword() {
  keyword.value = keywordInput.value.trim();
  reloadSnapshot();
}

/**
 * 重置筛选条件
 */
async function resetFilters() {
  keywordInput.value = '';
  keyword.value = '';
  level.value = 'all';
  await reloadSnapshot();
}

/**
 * 自动换行开关
 */
function toggleWrap() {
  wrapLines.value = !wrapLines.value;
}

/**
 * 记住本次选中的字号（下次打开后台直接沿用）
 * localStorage 不可用时静默降级，不影响其它功能
 */
function persistFontSize() {
  try {
    localStorage.setItem(LOG_CONSOLE_CONFIG.storageKey, String(fontSizePx.value));
  } catch (e) {
    console.warn('[SystemLogViewer] 字号持久化失败:', e);
  }
}

/**
 * 自动滚动开关：打开时立刻滚到底部
 */
async function toggleAutoScroll() {
  autoScroll.value = !autoScroll.value;
  if (autoScroll.value) await scrollToBottom();
}

/**
 * 复制当前显示的全部日志（只复制屏幕上看到的，不含临时行）
 */
async function copyAll() {
  const text = lines.value.map((line) => line.text).join('\n');
  if (!text) {
    uiStore.showToast('当前没有可复制的内容', 'info');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    uiStore.showToast(`已复制 ${lines.value.length} 行日志`, 'success');
  } catch (err: any) {
    // 非 HTTPS/无剪贴板权限时会走到这里：提示用户手动选中复制，而不是静默失败
    console.warn('[SystemLogViewer] 复制失败:', err?.message);
    uiStore.showToast('浏览器拒绝了剪贴板访问，请手动选中复制', 'error');
  }
}

/**
 * 清空视图（仅前端缓冲，服务器日志文件不受影响）
 */
function clearView() {
  lines.value = [];
  pending.value = '';
  truncated.value = false;
  uiStore.showToast('已清空当前视图（服务器日志文件未被修改）', 'info');
}

/**
 * 发送一条测试告警到飞书
 * 告警平时不出声，等真出事才发现 webhook 写错就晚了，所以给一个当场验证的入口
 */
async function sendTestAlert() {
  testingAlert.value = true;
  try {
    const res = await testSystemLogAlert();
    uiStore.showToast(res.data?.message || '测试告警已发送', 'success');
  } catch (err: any) {
    uiStore.showApiError(err, '发送测试告警失败');
  } finally {
    testingAlert.value = false;
  }
}

onMounted(async () => {
  await loadOptions();
  await reloadSnapshot();
});

// 离开页面时务必清掉定时器：后台面板是 v-if 切换，组件卸载后轮询会变成幽灵请求
onBeforeUnmount(stopAutoRefresh);

// 供父组件在需要时主动重新拉取
defineExpose({ reloadSnapshot });
</script>
