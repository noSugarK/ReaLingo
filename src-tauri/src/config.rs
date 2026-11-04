use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MODEL_QWEN3_5: &str = "qwen3.5-livetranslate-flash-realtime";
pub const MODEL_QWEN3_8: &str = "qwen3.8-livetranslate-flash-realtime";
/// Qwen3 uses the same protocol as Qwen3.5, but only 18 languages — the UI narrows the
/// pickers accordingly so a session cannot be opened with a target it will reject.
pub const MODEL_QWEN3: &str = "qwen3-livetranslate-flash-realtime";
pub const ASR_MODEL: &str = "qwen3-asr-flash-realtime";
pub const MODEL_OPENAI: &str = "gpt-realtime-translate";
/// Without a transcription model the OpenAI session sends no source transcript at all.
pub const OPENAI_ASR_MODEL: &str = "gpt-realtime-whisper";
pub const MODEL_GEMINI: &str = "gemini-3.5-live-translate-preview";
const GEMINI_URL: &str =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
/// The service's own default; any name from the Model Studio voice list works.
pub const VOICE: &str = "Tina";

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
// ponytail: only the regions that serve the LiveTranslate models. Model Studio has more
// (Frankfurt, Tokyo, Hong Kong, Virginia), but a Tokyo workspace answered "Model not exist"
// for every realtime model, and the LiveTranslate docs list just these two. Add a variant
// here (and in REGION_ID in store.ts) once another region carries them.
pub enum Region {
    #[default]
    Beijing,
    Singapore,
}

impl Region {
    /// Model Studio's region id, as it appears in the workspace domain.
    pub fn id(self) -> &'static str {
        match self {
            Region::Beijing => "cn-beijing",
            Region::Singapore => "ap-southeast-1",
        }
    }

    /// The shared DashScope domain, used when no workspace ID is set.
    pub fn shared_host(self) -> &'static str {
        match self {
            Region::Beijing => "dashscope.aliyuncs.com",
            Region::Singapore => "dashscope-intl.aliyuncs.com",
        }
    }
}

/// Which message format to speak — set by the protocol, not the vendor: Qwen3.8 talks a
/// different schema from Qwen3/3.5 on the same endpoint. Model and URL are free-form on top
/// of it, so any service that talks one of these protocols can be pointed at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// Qwen3.5, and Qwen3 with it.
    Qwen35,
    #[default]
    Qwen38,
    Openai,
    /// Google's Gemini Live API (`BidiGenerateContent`) with a `translationConfig`.
    Gemini,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub protocol: Protocol,
    /// The Model Studio key, shared by both Qwen protocols; named before OpenAI was added.
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub openai_key: String,
    #[serde(default)]
    pub gemini_key: String,
    /// Optional. Empty => the protocol's own endpoint; set => dialled as-is, plus `model=`
    /// unless the URL already carries one (Qwen, OpenAI — Gemini names its model in `setup`).
    #[serde(default)]
    pub url: String,
    /// Optional. Empty => the shared public endpoint; set => the workspace's dedicated domain.
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub region: Region,
    /// "auto" means: omit `language` entirely and let the model detect it.
    #[serde(default = "auto")]
    pub source_lang: String,
    #[serde(default = "en")]
    pub target_lang: String,
    /// Empty when absent, not a Qwen name: `model()` then fills in the protocol's own default.
    /// A Qwen default here sent "qwen3.5-…" to Gemini whenever the field was left out.
    #[serde(default)]
    pub model: String,
    /// Hotwords: source term -> preferred translation. The service asks for at most 1000.
    /// BTreeMap, not HashMap: the wire payload then has a stable order, which makes the
    /// frames readable when probing and the tests below deterministic.
    #[serde(default)]
    pub hotwords: BTreeMap<String, String>,
    /// Read the translation aloud. The frontend sends false where it cannot work: a target
    /// language the model will not speak, or Linux system audio, which would record it back.
    #[serde(default)]
    pub speak: bool,
    #[serde(default = "default_voice")]
    pub voice: String,
}

fn auto() -> String {
    "auto".into()
}
fn default_voice() -> String {
    VOICE.into()
}
fn en() -> String {
    "en".into()
}

/// Adds `name=value` to a URL's query unless that exact parameter is already there (so
/// `submodel=` does not count as `model=`), keeping any `#fragment` at the end.
pub fn with_param(url: &str, name: &str, value: &str) -> String {
    let (base, fragment) = url.split_once('#').unwrap_or((url, ""));
    let query = base.split_once('?').map_or("", |(_, q)| q);
    if query.split('&').any(|pair| pair.split('=').next() == Some(name)) {
        return url.to_string();
    }
    let sep = match base.split_once('?') {
        None => "?",
        Some((_, "")) => "",
        Some(_) if base.ends_with('&') => "",
        Some(_) => "&",
    };
    let fragment = if fragment.is_empty() { String::new() } else { format!("#{fragment}") };
    format!("{base}{sep}{name}={value}{fragment}")
}

impl Settings {
    pub fn key(&self) -> &str {
        match self.protocol {
            Protocol::Qwen35 | Protocol::Qwen38 => &self.api_key,
            Protocol::Openai => &self.openai_key,
            Protocol::Gemini => &self.gemini_key,
        }
    }

    pub fn key_mut(&mut self) -> &mut String {
        match self.protocol {
            Protocol::Qwen35 | Protocol::Qwen38 => &mut self.api_key,
            Protocol::Openai => &mut self.openai_key,
            Protocol::Gemini => &mut self.gemini_key,
        }
    }

    pub fn model(&self) -> &str {
        match (self.model.trim(), self.protocol) {
            ("", Protocol::Qwen35) => MODEL_QWEN3_5,
            ("", Protocol::Qwen38) => MODEL_QWEN3_8,
            ("", Protocol::Openai) => MODEL_OPENAI,
            ("", Protocol::Gemini) => MODEL_GEMINI,
            (m, _) => m,
        }
    }

    /// What the uplink must send: OpenAI rejects anything but 24 kHz; the rest take 16 kHz.
    pub fn sample_rate(&self) -> u32 {
        match self.protocol {
            Protocol::Openai => 24_000,
            Protocol::Qwen35 | Protocol::Qwen38 | Protocol::Gemini => 16_000,
        }
    }

    /// One chunk of base64 PCM, wrapped the way the protocol wants it.
    pub fn audio_frame(&self, b64: String) -> serde_json::Value {
        match self.protocol {
            Protocol::Qwen35 | Protocol::Qwen38 => serde_json::json!({ "type": "input_audio_buffer.append", "audio": b64 }),
            Protocol::Openai => serde_json::json!({ "type": "session.input_audio_buffer.append", "audio": b64 }),
            Protocol::Gemini => serde_json::json!({
                "realtimeInput": { "audio": { "data": b64, "mimeType": format!("audio/pcm;rate={}", self.sample_rate()) } }
            }),
        }
    }

    /// End of input: the server flushes the last sentence, then (except Gemini) says so.
    pub fn finish_frame(&self) -> serde_json::Value {
        match self.protocol {
            Protocol::Qwen35 | Protocol::Qwen38 => serde_json::json!({ "type": "session.finish" }),
            Protocol::Openai => serde_json::json!({ "type": "session.close" }),
            Protocol::Gemini => serde_json::json!({ "realtimeInput": { "audioStreamEnd": true } }),
        }
    }

    /// Whether this frame means everything owed after `finish_frame` has arrived.
    pub fn is_finished(&self, v: &serde_json::Value) -> bool {
        let ty = v.get("type").and_then(serde_json::Value::as_str);
        match self.protocol {
            Protocol::Qwen35 | Protocol::Qwen38 => ty == Some("session.finished"),
            Protocol::Openai => ty == Some("session.closed"),
            Protocol::Gemini => false,
        }
    }

    /// Whether the server ever says it is done. Gemini does not: after `audioStreamEnd` it
    /// keeps streaming silent audio indefinitely (seen live), so the end has to be inferred
    /// from the content going quiet instead.
    pub fn signals_finish(&self) -> bool {
        self.protocol != Protocol::Gemini
    }

    /// Silence to send after the last real audio, in samples. Gemini holds back the final
    /// words until it hears a pause: without this the last clause never arrived; with ~3 s
    /// of trailing silence it did (seen live).
    pub fn flush_silence(&self) -> usize {
        match self.protocol {
            Protocol::Gemini => self.sample_rate() as usize * 3,
            _ => 0,
        }
    }

    /// Gemini wants its `setup` acknowledged before any audio; the others take it at once.
    pub fn waits_for_setup(&self) -> bool {
        self.protocol == Protocol::Gemini
    }

    /// Target language as the service spells it: Gemini wants a script or regional variant
    /// for the two languages where it distinguishes them.
    fn target_code(&self) -> &str {
        match (self.protocol, self.target_lang.as_str()) {
            (Protocol::Gemini, "zh") => "zh-Hans",
            (Protocol::Gemini, "pt") => "pt-BR",
            (_, code) => code,
        }
    }

    pub fn ws_url(&self) -> String {
        let model = self.model();
        let custom = self.url.trim();
        if !custom.is_empty() {
            return match self.protocol {
                Protocol::Gemini => custom.to_string(),
                _ => with_param(custom, "model", model),
            };
        }
        match self.protocol {
            Protocol::Openai => return format!("wss://api.openai.com/v1/realtime/translations?model={model}"),
            // Without the key: it goes on at connect time, because Settings displays this.
            Protocol::Gemini => return GEMINI_URL.into(),
            Protocol::Qwen35 | Protocol::Qwen38 => {}
        }
        let ws = self.workspace_id.trim();
        let host = if ws.is_empty() {
            self.region.shared_host().to_string()
        } else {
            format!("{ws}.{}.maas.aliyuncs.com", self.region.id())
        };
        format!("wss://{host}/api-ws/v1/realtime?model={model}")
    }

    /// The `session.update` payload. Text always (it drives the subtitles); audio on top when
    /// speaking, which arrives as 24 kHz mono PCM16 in `response.audio.delta`.
    ///
    /// Gemini's equivalent is its `setup` message. Neither docs example has the layout right;
    /// the live endpoint, probed field by field, wants the transcription switches at the top of
    /// `setup` and `translationConfig` inside `generationConfig` — anything else is closed
    /// with "Unknown name … Cannot find field".
    pub fn session_update(&self) -> serde_json::Value {
        if self.protocol == Protocol::Gemini {
            // Echo off: a speaker already in the target language is not read back. The source
            // is always detected; there is no source-language setting to send.
            return serde_json::json!({
                "setup": {
                    // Accept the ID with or without the "models/" prefix the API itself uses.
                    "model": format!("models/{}", self.model().trim_start_matches("models/")),
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "translationConfig": { "targetLanguageCode": self.target_code(), "echoTargetLanguage": false }
                    },
                    "inputAudioTranscription": {},
                    "outputAudioTranscription": {}
                }
            });
        }
        // Source language, hotwords, voice and VAD have no OpenAI counterpart; the source is
        // always detected. Audio is always produced — `speak` only decides whether we play it.
        if self.protocol == Protocol::Openai {
            return serde_json::json!({
                "type": "session.update",
                "session": {
                    "audio": {
                        "input": { "transcription": { "model": OPENAI_ASR_MODEL } },
                        "output": { "language": self.target_lang }
                    }
                }
            });
        }
        let mut transcription = serde_json::json!({ "model": ASR_MODEL });
        // Omitting `language` is what tells the model to auto-detect the source.
        if self.source_lang != "auto" && !self.source_lang.is_empty() {
            transcription["language"] = self.source_lang.clone().into();
        }
        let mut translation = serde_json::json!({ "language": self.target_lang });
        // Only when there is something to send: an empty `corpus` is not a documented
        // shape, and the endpoint's reaction to one is anyone's guess.
        if !self.hotwords.is_empty() {
            translation["corpus"] = serde_json::json!({ "phrases": self.hotwords });
        }
        // Qwen3.8 supplies source transcription automatically. Its session schema uses
        // output_modalities and nested audio settings, not the earlier ASR/VAD fields.
        if self.protocol == Protocol::Qwen38 {
            return serde_json::json!({
                "type": "session.update",
                "session": {
                    "output_modalities": if self.speak { vec!["text", "audio"] } else { vec!["text"] },
                    "translation": translation,
                    "audio": {
                        // 3.8 only documents speaker_detection, threshold fixed at 0.5.
                        "input": { "turn_detection": { "type": "speaker_detection", "threshold": 0.5 } },
                        // The public endpoint can inherit Chelsie even in text-only mode, and
                        // the first audio input is then rejected. Always name a voice.
                        "output": { "voice": if self.voice.is_empty() { VOICE } else { &self.voice } }
                    }
                }
            });
        }
        let mut v = serde_json::json!({
            "type": "session.update",
            "session": {
                "modalities": ["text"],
                "input_audio_format": "pcm",
                // ponytail: session-scoped and immutable. Sending a second `session.update`
                // to retarget a live session is rejected with "session already started or
                // finished or failed" AND closes the socket — verified against the endpoint
                // with examples/probe.rs. Two-way translation therefore needs two parallel
                // sessions (one per direction), not a mid-flight switch. See README.
                "translation": translation,
                "input_audio_transcription": transcription,
                // An empty object leaves VAD unconfigured: the server never closes a turn,
                // so the text accumulates into one endless paragraph and later audio collides
                // with the still-running turn. Spell the parameters out.
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.2,
                    "silence_duration_ms": 800
                }
            }
        });
        if self.speak {
            let session = &mut v["session"];
            session["modalities"] = serde_json::json!(["text", "audio"]);
            session["voice"] = self.voice.clone().into();
            session["output_audio_format"] = "pcm".into();
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Qwen3.5 settings with a key for every vendor, so each test only changes what it is about.
    fn qwen(region: Region, workspace_id: &str) -> Settings {
        Settings {
            protocol: Protocol::Qwen35,
            api_key: "k".into(),
            openai_key: "o".into(),
            gemini_key: "g".into(),
            url: String::new(),
            workspace_id: workspace_id.into(),
            region,
            source_lang: "auto".into(),
            target_lang: "en".into(),
            model: MODEL_QWEN3_5.into(),
            hotwords: BTreeMap::new(),
            speak: false,
            voice: VOICE.into(),
        }
    }

    #[test]
    fn url_falls_back_to_public_domain_without_workspace() {
        assert!(qwen(Region::Beijing, "  ").ws_url().starts_with("wss://dashscope.aliyuncs.com/"));
        assert!(qwen(Region::Singapore, "")
            .ws_url()
            .starts_with("wss://dashscope-intl.aliyuncs.com/"));
    }

    #[test]
    fn url_uses_dedicated_domain_with_workspace() {
        assert!(qwen(Region::Beijing, "llm-abc")
            .ws_url()
            .starts_with("wss://llm-abc.cn-beijing.maas.aliyuncs.com/"));
        assert!(qwen(Region::Singapore, "llm-abc")
            .ws_url()
            .starts_with("wss://llm-abc.ap-southeast-1.maas.aliyuncs.com/"));
    }


    #[test]
    fn url_carries_the_selected_model() {
        assert!(qwen(Region::Beijing, "").ws_url().ends_with(&format!("?model={MODEL_QWEN3_5}")));

        let mut qwen3 = qwen(Region::Beijing, "");
        qwen3.model = MODEL_QWEN3.into();
        assert!(qwen3.ws_url().ends_with(&format!("?model={MODEL_QWEN3}")));
    }

    #[test]
    fn empty_model_falls_back_to_qwen3_5() {
        let mut blank = qwen(Region::Beijing, "");
        blank.model = String::new();
        assert!(blank.ws_url().ends_with(&format!("?model={MODEL_QWEN3_5}")));
    }

    #[test]
    fn a_missing_model_takes_the_protocols_own_default() {
        let parse = |p: &str| serde_json::from_value::<Settings>(serde_json::json!({ "protocol": p })).unwrap();
        assert_eq!(parse("qwen35").model(), MODEL_QWEN3_5);
        assert_eq!(parse("qwen38").model(), MODEL_QWEN3_8);
        assert_eq!(parse("openai").model(), MODEL_OPENAI);
        assert_eq!(parse("gemini").model(), MODEL_GEMINI);
    }

    #[test]
    fn turn_detection_is_configured_not_empty() {
        let vad = &qwen(Region::Beijing, "").session_update()["session"]["turn_detection"];
        assert_eq!(vad["type"], "server_vad");
        assert!(vad["silence_duration_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn no_hotwords_omits_corpus() {
        let translation = &qwen(Region::Beijing, "").session_update()["session"]["translation"];
        assert_eq!(translation["language"], "en");
        assert!(translation.get("corpus").is_none());
    }

    #[test]
    fn hotwords_go_under_translation_corpus_phrases() {
        let mut with = qwen(Region::Beijing, "");
        with.hotwords.insert("人工智能".into(), "Artificial Intelligence".into());
        let phrases = &with.session_update()["session"]["translation"]["corpus"]["phrases"];
        assert_eq!(phrases["人工智能"], "Artificial Intelligence");
    }

    #[test]
    fn speaking_adds_the_audio_modality_and_voice() {
        let quiet = qwen(Region::Beijing, "").session_update();
        assert_eq!(quiet["session"]["modalities"], serde_json::json!(["text"]));
        assert!(quiet["session"].get("voice").is_none());

        let mut loud = qwen(Region::Beijing, "");
        loud.speak = true;
        loud.voice = "Ethan".into();
        let session = &loud.session_update()["session"];
        assert_eq!(session["modalities"], serde_json::json!(["text", "audio"]));
        assert_eq!(session["voice"], "Ethan");
        assert_eq!(session["output_audio_format"], "pcm");
    }

    #[test]
    fn auto_source_omits_language_field() {
        let v = qwen(Region::Beijing, "").session_update();
        assert!(v["session"]["input_audio_transcription"].get("language").is_none());

        let mut fixed = qwen(Region::Beijing, "");
        fixed.source_lang = "zh".into();
        assert_eq!(fixed.session_update()["session"]["input_audio_transcription"]["language"], "zh");
    }

    #[test]
    fn qwen3_8_uses_its_own_session_schema_and_endpoint_model() {
        let mut settings = qwen(Region::Beijing, "llm-abc");
        settings.protocol = Protocol::Qwen38;
        settings.model.clear();
        settings.voice = "Chelsie".into();
        settings.hotwords.insert("人工智能".into(), "AI".into());
        assert!(settings.ws_url().ends_with(&format!("?model={MODEL_QWEN3_8}")));
        let update = settings.session_update();
        let session = &update["session"];
        assert_eq!(session["output_modalities"], serde_json::json!(["text"]));
        assert_eq!(session["audio"]["output"]["voice"], "Chelsie");
        assert_eq!(session["audio"]["input"]["turn_detection"]["type"], "speaker_detection");
        assert_eq!(session["translation"]["corpus"]["phrases"]["人工智能"], "AI");
        for old_field in ["modalities", "input_audio_transcription", "turn_detection", "voice", "input_audio_format"] {
            assert!(session.get(old_field).is_none(), "unexpected field: {old_field}");
        }
        settings.speak = true;
        assert_eq!(settings.session_update()["session"]["output_modalities"], serde_json::json!(["text", "audio"]));
        settings.voice.clear();
        assert_eq!(settings.session_update()["session"]["audio"]["output"]["voice"], "Tina");
        settings.workspace_id.clear();
        assert_eq!(settings.ws_url(), format!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={MODEL_QWEN3_8}"));
        settings.region = Region::Singapore;
        assert_eq!(settings.ws_url(), format!("wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model={MODEL_QWEN3_8}"));
    }

    #[test]
    fn the_schema_follows_the_protocol_not_the_model_name() {
        // A renamed 3.8 deployment still needs the 3.8 schema...
        let mut renamed = qwen(Region::Beijing, "");
        renamed.protocol = Protocol::Qwen38;
        renamed.model = "my-qwen38-deploy".into();
        assert!(renamed.session_update()["session"].get("output_modalities").is_some());
        // ...and the 3.8 model name alone no longer switches a 3.5 session over.
        let mut named = qwen(Region::Beijing, "");
        named.model = MODEL_QWEN3_8.into();
        assert!(named.session_update()["session"].get("input_audio_transcription").is_some());
        assert_eq!(renamed.key(), named.key());
    }

    #[test]
    fn openai_speaks_its_own_protocol() {
        let mut o = qwen(Region::Singapore, "llm-abc");
        o.protocol = Protocol::Openai;
        o.model.clear();
        o.target_lang = "zh".into();
        assert_eq!(o.ws_url(), "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate");
        assert_eq!(o.key(), "o");
        assert_eq!(o.sample_rate(), 24_000);
        assert_eq!(o.audio_frame("QQ==".into())["type"], "session.input_audio_buffer.append");
        let session = &o.session_update()["session"];
        assert_eq!(session["audio"]["output"]["language"], "zh");
        assert_eq!(session["audio"]["input"]["transcription"]["model"], OPENAI_ASR_MODEL);
        assert!(session.get("translation").is_none());
    }

    #[test]
    fn custom_url_is_dialled_as_is_plus_model() {
        let mut c = qwen(Region::Beijing, "");
        c.url = " wss://proxy.example/v1/rt ".into();
        assert_eq!(c.ws_url(), format!("wss://proxy.example/v1/rt?model={MODEL_QWEN3_5}"));
        c.url = "wss://proxy.example/rt?x=1".into();
        assert_eq!(c.ws_url(), format!("wss://proxy.example/rt?x=1&model={MODEL_QWEN3_5}"));
        c.url = "wss://proxy.example/rt?model=mine".into();
        assert_eq!(c.ws_url(), "wss://proxy.example/rt?model=mine");
        c.model = " my-model ".into();
        c.url.clear();
        assert!(c.ws_url().ends_with("?model=my-model"));
    }

    #[test]
    fn params_are_matched_by_name_and_go_before_the_fragment() {
        // A parameter that merely ends in "model" is not one.
        assert_eq!(with_param("wss://h/rt?submodel=x", "model", "m"), "wss://h/rt?submodel=x&model=m");
        assert_eq!(with_param("wss://h/rt?a=1&model=mine", "model", "m"), "wss://h/rt?a=1&model=mine");
        assert_eq!(with_param("wss://h/rt#frag", "model", "m"), "wss://h/rt?model=m#frag");
        assert_eq!(with_param("wss://h/rt?a=1#frag", "key", "k"), "wss://h/rt?a=1&key=k#frag");
        assert_eq!(with_param("wss://h/rt?", "key", "k"), "wss://h/rt?key=k");
        assert_eq!(with_param("wss://h/rt?a=1&", "key", "k"), "wss://h/rt?a=1&key=k");
        // A Gemini proxy URL that already carries its own key keeps it, rather than gaining two.
        assert_eq!(with_param("wss://h/rt?key=mine", "key", "k"), "wss://h/rt?key=mine");
    }

    #[test]
    fn a_gemini_model_id_may_carry_the_models_prefix() {
        let mut g = qwen(Region::Beijing, "");
        g.protocol = Protocol::Gemini;
        g.model = "models/gemini-x".into();
        assert_eq!(g.session_update()["setup"]["model"], "models/gemini-x");
        g.model = "gemini-x".into();
        assert_eq!(g.session_update()["setup"]["model"], "models/gemini-x");
    }

    #[test]
    fn gemini_sets_up_translation_in_its_own_message() {
        let mut g = qwen(Region::Beijing, "llm-abc");
        g.protocol = Protocol::Gemini;
        g.model.clear();
        g.target_lang = "zh".into();
        // The key never reaches this string: it is what the Settings preview shows.
        assert_eq!(g.ws_url(), GEMINI_URL);
        assert!(!g.ws_url().contains("key="));
        assert_eq!(g.key(), "g");
        assert_eq!(g.sample_rate(), 16_000);
        assert!(g.waits_for_setup());

        // Layout the live endpoint accepted (probed with a dud key, which it only rejects
        // once the payload itself parses): transcription switches on `setup`,
        // translationConfig under generationConfig.
        let setup = &g.session_update()["setup"];
        assert_eq!(setup["model"], "models/gemini-3.5-live-translate-preview");
        let cfg = &setup["generationConfig"];
        assert_eq!(cfg["responseModalities"], serde_json::json!(["AUDIO"]));
        assert_eq!(cfg["translationConfig"]["targetLanguageCode"], "zh-Hans");
        assert_eq!(cfg["translationConfig"]["echoTargetLanguage"], false);
        assert!(setup.get("inputAudioTranscription").is_some() && setup.get("outputAudioTranscription").is_some());
        assert!(cfg.get("inputAudioTranscription").is_none() && setup.get("translationConfig").is_none());
        g.target_lang = "ja".into();
        assert_eq!(g.session_update()["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"], "ja");

        let audio = g.audio_frame("QQ==".into());
        assert_eq!(audio["realtimeInput"]["audio"]["mimeType"], "audio/pcm;rate=16000");
        assert_eq!(audio["realtimeInput"]["audio"]["data"], "QQ==");
        assert_eq!(g.finish_frame()["realtimeInput"]["audioStreamEnd"], true);
        // A custom URL is a proxy for the same protocol: no model= tacked on.
        g.url = "wss://proxy.example/gemini".into();
        assert_eq!(g.ws_url(), "wss://proxy.example/gemini");
    }
}
