// The searchable language grid, shared by the home page and the models page.
// Both pages carry the same markup: #apis (buttons with data-v), #q, #count, #langs.
(function () {
  var box = document.getElementById("langs"); if (!box) return;
  var q = document.getElementById("q"), count = document.getElementById("count");
  var zh = function () { return document.documentElement.lang === "zh"; };
  var LANGS = [["zh","中文","Chinese",1],["en","英语","English",1],["ja","日语","Japanese",1],["ko","韩语","Korean",1],["fr","法语","French",1],["de","德语","German",1],["es","西班牙语","Spanish",1],["pt","葡萄牙语","Portuguese",1],["ru","俄语","Russian",1],["it","意大利语","Italian",1],["ar","阿拉伯语","Arabic",1],["id","印度尼西亚语","Indonesian",1],["th","泰语","Thai",1],["vi","越南语","Vietnamese",1],["tr","土耳其语","Turkish",1],["hi","印地语","Hindi",1],["ms","马来语","Malay",1],["nl","荷兰语","Dutch",1],["ur","乌尔都语","Urdu",1],["nb","挪威语","Norwegian",1],["sv","瑞典语","Swedish",1],["da","丹麦语","Danish",1],["he","希伯来语","Hebrew",1],["fi","芬兰语","Finnish",1],["pl","波兰语","Polish",1],["is","冰岛语","Icelandic",1],["cs","捷克语","Czech",1],["fil","菲律宾语","Filipino",1],["fa","波斯语","Persian",1],["yue","粤语","Cantonese",0],["el","希腊语","Greek",0],["af","南非荷兰语","Afrikaans",0],["ast","阿斯图里亚斯语","Asturian",0],["az","阿塞拜疆语","Azerbaijani",0],["be","白俄罗斯语","Belarusian",0],["bg","保加利亚语","Bulgarian",0],["bn","孟加拉语","Bengali",0],["bs","波斯尼亚语","Bosnian",0],["ca","加泰罗尼亚语","Catalan",0],["ceb","宿务语","Cebuano",0],["et","爱沙尼亚语","Estonian",0],["gl","加利西亚语","Galician",0],["gu","古吉拉特语","Gujarati",0],["hr","克罗地亚语","Croatian",0],["hu","匈牙利语","Hungarian",0],["jv","爪哇语","Javanese",0],["kk","哈萨克语","Kazakh",0],["kn","卡纳达语","Kannada",0],["ky","柯尔克孜语","Kyrgyz",0],["lv","拉脱维亚语","Latvian",0],["mk","马其顿语","Macedonian",0],["ml","马拉雅拉姆语","Malayalam",0],["mr","马拉地语","Marathi",0],["pa","旁遮普语","Punjabi",0],["ro","罗马尼亚语","Romanian",0],["sk","斯洛伐克语","Slovak",0],["sl","斯洛文尼亚语","Slovenian",0],["sw","斯瓦希里语","Swahili",0],["tg","塔吉克语","Tajik",0],["uk","乌克兰语","Ukrainian",0]];
  var SPK = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var inList = function (s) { var l = s.split(" "); return function (c) { return l.indexOf(c) >= 0; }; };
  // per API, mirrors languageCodes() / canSpeak() in src/languages.ts
  var APIS = {
    qwen: { has: function () { return true; } },
    gemini: { has: function (c) { return "yue ast bs ceb ky tg".split(" ").indexOf(c) < 0; }, speaksAll: true },
    openai: { has: inList("es pt fr ja ru zh de ko hi id vi it en"), speaksAll: true },
    volc: { has: inList("zh en de fr es id ja pt ko tr ms nl ro pl cs ar th vi ru it"), speaks: inList("zh en de fr es id ja pt") }
  };
  var api = APIS.qwen;
  function render() {
    // supported ones first, so switching regroups the grid instead of leaving holes
    var sorted = LANGS.filter(function (l) { return api.has(l[0]); }).concat(LANGS.filter(function (l) { return !api.has(l[0]); }));
    box.innerHTML = sorted.map(function (l) {
      var has = api.has(l[0]);
      return "<div" + (has ? "" : ' class="no"') + ' data-k="' + (l[0] + " " + l[1] + " " + l[2]).toLowerCase() + '"><span>' + (zh() ? l[1] : l[2]) +
        " <small>" + l[0] + "</small></span>" + (has && (api.speaks ? api.speaks(l[0]) : api.speaksAll || l[3]) ? SPK : "") + "</div>";
    }).join("");
    filter();
  }
  function filter() {
    var s = q.value.trim().toLowerCase(), n = 0;
    box.querySelectorAll("div").forEach(function (d) { var hit = !s || d.dataset.k.indexOf(s) >= 0; d.classList.toggle("off", !hit); n += hit && !d.classList.contains("no"); });
    count.textContent = zh() ? n + " / 60 种可用" : n + " of 60 available";
  }
  q.addEventListener("input", filter);
  document.getElementById("apis").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
    api = APIS[b.dataset.v]; render();
  });
  // the page flips html[lang] in its own #lang handler, which runs before this bubbles up
  document.addEventListener("click", function (e) { if (e.target.closest("#lang")) render(); });
  render();
})();
