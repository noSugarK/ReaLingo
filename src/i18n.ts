import { ref } from "vue";

const zh = {
  appTitle: "ReaLingo",
  appSub: "Qwen3.5 LiveTranslate",

  srcTitle: "音频来源",
  srcMic: "麦克风",
  srcSystem: "系统声音",
  srcFile: "音频文件",
  device: "设备",
  noDevice: "未找到设备",
  loopbackOnlyWin: "系统声音采集目前仅支持 Windows",
  pickFile: "选择音频文件",
  fileFormats: "支持 mp3 / wav / m4a / flac / ogg",
  level: "输入电平",

  langTitle: "语言",
  from: "源语言",
  to: "目标语言",
  swap: "互换",
  auto: "自动检测",
  searchLang: "搜索语言…",

  start: "开始翻译",
  stop: "停止",
  statusIdle: "待机",
  statusConnecting: "连接中…",
  statusConnected: "已连接",
  statusListening: "正在听…",
  statusError: "出错",
  statusNoKey: "未配置 API Key",

  subTitle: "字幕窗",
  subShow: "显示字幕窗",
  subMode: "显示内容",
  subBoth: "双语",
  subTarget: "仅译文",
  subSource: "仅原文",
  subOpacity: "背景不透明度",
  subFontSize: "字号",
  subColors: "字幕颜色",
  subColor: "译文颜色",
  subSrcColor: "原文颜色",
  subOutline: "文字描边",
  subLock: "锁定（点击穿透）",
  subLockShort: "点击穿透",
  subLocked: "已锁定 · 在主窗解锁",

  streamTitle: "翻译流",
  streamEmpty: "点击「开始翻译」，译文会实时出现在这里",
  clear: "清空",
  exportTxt: "导出 TXT",
  exportSrt: "导出 SRT",
  copied: "已复制",

  trayShow: "显示主窗口",
  trayQuit: "退出 ReaLingo",
  toTray: "收起到托盘",

  settings: "设置",
  apiKey: "API Key",
  apiKeyHint: "百炼控制台 → API-KEY 页面获取，仅保存在本机",
  workspace: "业务空间 ID",
  workspaceHint: "选填。留空使用公共域名；填写后走业务空间专属域名（性能更好），可在百炼控制台业务空间详情页查看",
  region: "地域",
  regionBJ: "华北2（北京）",
  regionSG: "新加坡",
  endpoint: "接入地址",
  theme: "外观",
  themeLight: "浅色",
  themeDark: "深色",
  themeSystem: "跟随系统",
  uiLang: "界面语言",
  save: "保存",
  close: "关闭",

  errNoKey: "请先在设置里填写 API Key",
  errPickDevice: "请先选择一个音频设备",
  errPickFile: "请先选择一个音频文件",
  fileDone: "文件处理完成",
};

const en: typeof zh = {
  appTitle: "ReaLingo",
  appSub: "Qwen3.5 LiveTranslate",

  srcTitle: "Audio source",
  srcMic: "Microphone",
  srcSystem: "System audio",
  srcFile: "Audio file",
  device: "Device",
  noDevice: "No device found",
  loopbackOnlyWin: "System audio capture is Windows-only for now",
  pickFile: "Choose an audio file",
  fileFormats: "mp3 / wav / m4a / flac / ogg",
  level: "Input level",

  langTitle: "Languages",
  from: "Source",
  to: "Target",
  swap: "Swap",
  auto: "Auto detect",
  searchLang: "Search language…",

  start: "Start",
  stop: "Stop",
  statusIdle: "Idle",
  statusConnecting: "Connecting…",
  statusConnected: "Connected",
  statusListening: "Listening…",
  statusError: "Error",
  statusNoKey: "API key not set",

  subTitle: "Subtitle overlay",
  subShow: "Show overlay",
  subMode: "Content",
  subBoth: "Bilingual",
  subTarget: "Translation only",
  subSource: "Source only",
  subOpacity: "Background opacity",
  subFontSize: "Font size",
  subColors: "Subtitle colors",
  subColor: "Translation color",
  subSrcColor: "Source color",
  subOutline: "Text outline",
  subLock: "Lock (click-through)",
  subLockShort: "Click-through",
  subLocked: "Locked · unlock in main window",

  streamTitle: "Translation stream",
  streamEmpty: "Hit Start — translations will stream in here",
  clear: "Clear",
  exportTxt: "Export TXT",
  exportSrt: "Export SRT",
  copied: "Copied",

  trayShow: "Show window",
  trayQuit: "Quit ReaLingo",
  toTray: "Minimize to tray",

  settings: "Settings",
  apiKey: "API Key",
  apiKeyHint: "Get it from Model Studio → API-KEY. Stored locally only.",
  workspace: "Workspace ID",
  workspaceHint:
    "Optional. Leave blank to use the public endpoint; filling it in uses your workspace's dedicated domain (better performance). Find it on the workspace detail page.",
  region: "Region",
  regionBJ: "China (Beijing)",
  regionSG: "Singapore",
  endpoint: "Endpoint",
  theme: "Appearance",
  themeLight: "Light",
  themeDark: "Dark",
  themeSystem: "System",
  uiLang: "Interface language",
  save: "Save",
  close: "Close",

  errNoKey: "Set your API key in Settings first",
  errPickDevice: "Pick an audio device first",
  errPickFile: "Pick an audio file first",
  fileDone: "File finished",
};

const DICT = { zh, en };
export type Locale = keyof typeof DICT;
export type Key = keyof typeof zh;

export const locale = ref<Locale>(
  (localStorage.getItem("locale") as Locale) ||
    (navigator.language.startsWith("zh") ? "zh" : "en")
);

export function setLocale(l: Locale) {
  locale.value = l;
  localStorage.setItem("locale", l);
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
}

export function t(key: Key): string {
  return DICT[locale.value][key];
}
