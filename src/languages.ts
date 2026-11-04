import type { Protocol } from "./store";

// Languages supported by qwen3.5-livetranslate-flash-realtime.
// `tts: true` = the model can also speak this language (the "read aloud" switch).
const TABLE = `
zh|中文|Chinese|1
en|英语|English|1
ja|日语|Japanese|1
ko|韩语|Korean|1
fr|法语|French|1
de|德语|German|1
es|西班牙语|Spanish|1
pt|葡萄牙语|Portuguese|1
ru|俄语|Russian|1
it|意大利语|Italian|1
ar|阿拉伯语|Arabic|1
id|印度尼西亚语|Indonesian|1
th|泰语|Thai|1
vi|越南语|Vietnamese|1
tr|土耳其语|Turkish|1
hi|印地语|Hindi|1
ms|马来语|Malay|1
nl|荷兰语|Dutch|1
ur|乌尔都语|Urdu|1
nb|挪威语|Norwegian|1
sv|瑞典语|Swedish|1
da|丹麦语|Danish|1
he|希伯来语|Hebrew|1
fi|芬兰语|Finnish|1
pl|波兰语|Polish|1
is|冰岛语|Icelandic|1
cs|捷克语|Czech|1
fil|菲律宾语|Filipino|1
fa|波斯语|Persian|1
yue|粤语|Cantonese|0
el|希腊语|Greek|0
af|南非荷兰语|Afrikaans|0
ast|阿斯图里亚斯语|Asturian|0
az|阿塞拜疆语|Azerbaijani|0
be|白俄罗斯语|Belarusian|0
bg|保加利亚语|Bulgarian|0
bn|孟加拉语|Bengali|0
bs|波斯尼亚语|Bosnian|0
ca|加泰罗尼亚语|Catalan|0
ceb|宿务语|Cebuano|0
et|爱沙尼亚语|Estonian|0
gl|加利西亚语|Galician|0
gu|古吉拉特语|Gujarati|0
hr|克罗地亚语|Croatian|0
hu|匈牙利语|Hungarian|0
jv|爪哇语|Javanese|0
kk|哈萨克语|Kazakh|0
kn|卡纳达语|Kannada|0
ky|柯尔克孜语|Kyrgyz|0
lv|拉脱维亚语|Latvian|0
mk|马其顿语|Macedonian|0
ml|马拉雅拉姆语|Malayalam|0
mr|马拉地语|Marathi|0
pa|旁遮普语|Punjabi|0
ro|罗马尼亚语|Romanian|0
sk|斯洛伐克语|Slovak|0
sl|斯洛文尼亚语|Slovenian|0
sw|斯瓦希里语|Swahili|0
tg|塔吉克语|Tajik|0
uk|乌克兰语|Ukrainian|0
`;

export interface Lang {
  code: string;
  zh: string;
  en: string;
  tts: boolean;
}

export const LANGUAGES: Lang[] = TABLE.trim()
  .split("\n")
  .map((line) => {
    const [code, zh, en, tts] = line.split("|");
    return { code, zh, en, tts: tts === "1" };
  });

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export const MODEL_QWEN3_5 = "qwen3.5-livetranslate-flash-realtime";
export const MODEL_QWEN3_8 = "qwen3.8-livetranslate-flash-realtime";
export const MODEL_QWEN3 = "qwen3-livetranslate-flash-realtime";
export const MODEL_OPENAI = "gpt-realtime-translate";
export const MODEL_GEMINI = "gemini-3.5-live-translate-preview";
/** Display only: the Volcengine AST endpoint takes no model name. */
export const MODEL_VOLC = "doubao-ast-2.0";

/** Who issues the key and runs the endpoint. Protocols of one vendor share both. */
export type Vendor = "qwen" | "openai" | "gemini" | "volc";

/** Qwen3 covers only these 18 languages. */
const QWEN3_CODES = new Set(
  "en zh ru fr de pt es it id ko ja vi th ar yue hi el tr".split(" ")
);
/** gpt-realtime-translate hears 70+ languages but speaks only these 13 (all tts-capable). */
const OPENAI_CODES = new Set("es pt fr ja ru zh de ko hi id vi it en".split(" "));

/** Of this table, the ones Gemini Live Translate's 70+ language list does not include. */
const GEMINI_MISSING = new Set("yue ast bs ceb ky tg".split(" "));
const GEMINI_CODES = new Set(LANGUAGES.map((l) => l.code).filter((c) => !GEMINI_MISSING.has(c)));

/** Volcengine AST: its 20 languages, one side of every pair Chinese or English. */
const VOLC_CODES = new Set("zh en de fr es id ja pt ko tr ms nl ro pl cs ar th vi ru it".split(" "));
/** The ones it can also speak, cloning the speaker's voice (the presets speak zh/en). */
const VOLC_SPEAKS = new Set("zh en de fr es id ja pt".split(" "));

/**
 * How the source language is set: always detected by the service, detected or named by the
 * user, or named and never detected.
 */
export type SourceMode = "detected" | "either" | "named";

/**
 * Everything the UI decides per protocol, in one place: each of these used to be its own
 * `=== "openai" || === "gemini"` check, written differently at every site. A component that
 * needs a new per-protocol difference adds a field here rather than testing the protocol.
 */
export interface ProtocolInfo {
  vendor: Vendor;
  source: SourceMode;
  /** The languages it translates; absent means the whole table. */
  langs?: ReadonlySet<string>;
  /** Which target languages it reads aloud: all of them, those the table marks, or these. */
  speaks: "all" | "table" | ReadonlySet<string>;
  /** The voices to offer; null when the service chooses the voice itself. */
  voices: VoiceList | null;
  /** A custom URL is dialled exactly as typed: the model goes in the setup message, not the URL. */
  urlAsIs: boolean;
  /** Can translate both ways between Chinese and English in one session. */
  twoWay: boolean;
  /** Every pair must have one of these on one side; empty means any pair goes. */
  hub: readonly string[];
}

export const PROTOCOLS: Record<Protocol, ProtocolInfo> = {
  qwen35: { vendor: "qwen", source: "either", speaks: "table", voices: "qwen", urlAsIs: false, twoWay: false, hub: [] },
  qwen38: { vendor: "qwen", source: "detected", speaks: "table", voices: "qwen", urlAsIs: false, twoWay: false, hub: [] },
  openai: { vendor: "openai", source: "detected", langs: OPENAI_CODES, speaks: "all", voices: null, urlAsIs: false, twoWay: false, hub: [] },
  gemini: { vendor: "gemini", source: "detected", langs: GEMINI_CODES, speaks: "all", voices: null, urlAsIs: true, twoWay: false, hub: [] },
  volc: { vendor: "volc", source: "named", langs: VOLC_CODES, speaks: VOLC_SPEAKS, voices: "volc", urlAsIs: true, twoWay: true, hub: ["zh", "en"] },
};

export interface Preset {
  id: string;
  name: string;
  langs: number;
}

/** The models offered per protocol; the first is the protocol's default. */
export const PRESETS: Record<Protocol, Preset[]> = {
  qwen35: [
    { id: MODEL_QWEN3_5, name: "Qwen3.5", langs: 60 },
    { id: MODEL_QWEN3, name: "Qwen3", langs: 18 },
  ],
  qwen38: [{ id: MODEL_QWEN3_8, name: "Qwen3.8", langs: 60 }],
  openai: [{ id: MODEL_OPENAI, name: "GPT-Realtime-Translate", langs: 13 }],
  gemini: [{ id: MODEL_GEMINI, name: "Gemini 3.5 Live Translate", langs: 54 }],
  volc: [{ id: MODEL_VOLC, name: "豆包同声传译 2.0", langs: 20 }],
};

/** Short display name: the preset's own, or the raw id for a custom model. */
export function modelName(protocol: Protocol, model: string): string {
  return PRESETS[protocol].find((p) => p.id === model)?.name ?? (model || PRESETS[protocol][0].name);
}

/** Codes the given model can actually translate into. Qwen3 is a model of the Qwen3.5
 * protocol with a smaller list, so the model has the last word there. */
export function languageCodes(protocol: Protocol, model: string): string[] {
  const all = LANGUAGES.map((l) => l.code);
  const only = model === MODEL_QWEN3 ? QWEN3_CODES : PROTOCOLS[protocol].langs;
  return only ? all.filter((c) => only.has(c)) : all;
}

export function canSpeak(protocol: Protocol, code: string): boolean {
  const speaks = PROTOCOLS[protocol].speaks;
  if (speaks === "all") return true;
  if (speaks === "table") return BY_CODE.get(code)?.tts ?? false;
  return speaks.has(code);
}

// Voices the LiveTranslate models accept for `session.voice`, from the Model Studio voice list
// (help.aliyun.com/zh/model-studio/omni-voice-list): voice|中文名|中文简介|English summary.
// The summaries are condensed from the official descriptions.
const VOICE_TABLE = `
Tina|甜甜|甜美温暖的女声（默认）|Sweet, warm female (default)
Cindy|林欣宜|台湾腔，娇嗲女声|Cutesy female, Taiwanese accent
Serena|苏瑶|温柔女声|Gentle female
Maia|四月|知性温柔的女声|Poised, gentle female
Mia|舒然|舒缓治愈的生活博主|Soothing lifestyle-vlogger female
Momo|茉兔|俏皮爱撒娇|Playful, cute female
Angel|安琪|略带台湾口音的甜美女声|Sweet female, light Taiwanese accent
Qiao|小乔妹|甜美又有个性|Sweet but spirited female
Katerina|卡捷琳娜|成熟御姐，韵律感强|Mature female, rich cadence
Jennifer|詹妮弗|电影质感的美式女声|Cinematic American female
Mione|敏儿|成熟知性的英式女声|Mature British female
Sohee|素熙|温柔开朗的韩国女声|Warm, cheerful Korean female
Sonrisa|索尼莎|热情开朗的拉美女声|Lively Latin American female
Marina|玛丽娜|多元文化背景的女声|Cosmopolitan female
Hana|阿幸|成熟的越南女声|Mature Vietnamese female
Griet|海娜|成熟文艺的荷兰女声|Mature, artsy Dutch female
Eliška|艾莉卡|温润的中欧女声|Warm Central European female
Siiri|西芮|内敛温柔，语速舒缓|Reserved, unhurried female
Ingrid|林恩|淳朴的挪威女声|Down-to-earth Norwegian female
Sigga|海娜|知性的冰岛女声|Poised Icelandic female
Bea|雅娜|甜美的菲律宾女声|Sweet Filipino female
Chloe|思怡|马来西亚白领女声|Malaysian office-worker female
Roya|萝雅|爽朗自由的运动女孩|Sporty, free-spirited female
Sunnybobi|知芝|大大咧咧的邻家女孩|Easygoing girl next door
Liora Mira|清欢|温柔有烟火气的女声|Tender, homely female
Ono Anna|小野杏|古灵精怪的青梅竹马|Mischievous childhood friend
Raymond|林川野|清亮的宅男声|Clear-voiced young male
Ethan|晨煦|阳光有活力，略带北方口音|Bright, upbeat male, slight northern accent
Harvey|厚|低沉温和的成熟男声|Deep, mellow mature male
Evan|江晨|青涩的男大学生|Youthful college male
Wil|伟伦|港台腔小哥哥|Young male, Hong Kong/Taiwan accent
Ryan|甜茶|节奏强、戏感足|Punchy, dramatic male
Aiden|艾登|美式大男孩|Young American male
Lenn|莱恩|理性又带点叛逆的德国青年|Rational, edgy German male
Bodega|博德加|热情的西班牙大叔|Warm Spanish uncle
Emilien|埃米尔安|浪漫的法国男声|Romantic French male
Andre|安德雷|沉稳磁性的男声|Calm, magnetic male
Alek|阿列克|外冷内暖的俄罗斯男声|Cool-yet-warm Russian male
Rizky|阿力|有个性的印尼青年|Distinctive Indonesian young male
Arda|阿尔达|干净温润的男声|Clean, warm male
Dolce|多尔切|慵懒的意大利大叔|Laid-back Italian uncle
Jakub|雅克|磁性的波兰文艺青年|Magnetic, artsy Polish male
Theo Calm|予安|沉静治愈的声音|Calm, healing voice
Joyner|阿逗|搞笑夸张的喜剧声|Over-the-top comic
Gold|金爷|西海岸说唱风|West Coast rapper
Li Cassian|李公公|宫廷太监角色音|Imperial eunuch character
Radio Gol|拉迪奥·戈尔|足球解说风|Football commentator
`;

export interface Voice {
  id: string;
  zh: string;
  descZh: string;
  descEn: string;
  /** What the picker shows, when the id is an API name no one should have to read. */
  label?: { zh: string; en: string };
}

export const VOICES: Voice[] = VOICE_TABLE.trim()
  .split("\n")
  .map((line) => {
    const [id, zh, descZh, descEn] = line.split("|");
    return { id, zh, descZh, descEn };
  });

/**
 * Volcengine: clone the speaker, or one of its two preset voices (Chinese and English only).
 * The preset ids mirror `volc::VOICES` in src-tauri/src/volc.rs; `clone` is `volc::CLONE`.
 */
export const VOLC_VOICES: Voice[] = [
  { id: "clone", zh: "复刻说话人", descZh: "用说话人自己的音色朗读", descEn: "Clone the speaker's own voice", label: { zh: "复刻说话人", en: "Speaker's own voice" } },
  { id: "zh_female_vv_uranus_bigtts", zh: "vv", descZh: "女声，仅中英", descEn: "Female, Chinese and English only", label: { zh: "vv", en: "vv" } },
  { id: "zh_male_jingqiangkanye_emo_mars_bigtts", zh: "京腔侃爷", descZh: "男声，仅中英", descEn: "Male, Chinese and English only", label: { zh: "京腔侃爷", en: "Jingqiang Kanye" } },
];

/** The voice lists `ProtocolInfo.voices` names. */
export type VoiceList = "qwen" | "volc";
export const VOICE_LISTS: Record<VoiceList, Voice[]> = { qwen: VOICES, volc: VOLC_VOICES };

/** A voice as the picker shows it: its own label if it has one, else the name it is called by. */
export function voiceLabel(v: Voice, locale: "zh" | "en"): string {
  if (v.label) return v.label[locale];
  return locale === "zh" ? `${v.id} · ${v.zh}` : v.id;
}

export function langName(code: string, locale: "zh" | "en"): string {
  if (code === "auto") return locale === "zh" ? "自动检测" : "Auto detect";
  const l = BY_CODE.get(code);
  return l ? l[locale] : code;
}
