// Languages supported by qwen3.5-livetranslate-flash-realtime.
// `tts: true` = the model can also speak this language (we only use text, kept for later).
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

export function langName(code: string, locale: "zh" | "en"): string {
  if (code === "auto") return locale === "zh" ? "自动检测" : "Auto detect";
  const l = BY_CODE.get(code);
  return l ? l[locale] : code;
}
