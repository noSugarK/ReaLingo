use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MODEL_QWEN3_5: &str = "qwen3.5-livetranslate-flash-realtime";
pub const MODEL_QWEN3_8: &str = "qwen3.8-livetranslate-flash-realtime";
/// Qwen3 uses the same protocol as Qwen3.5, but only 18 languages — the UI narrows the
/// pickers accordingly so a session cannot be opened with a target it will reject.
pub const MODEL_QWEN3: &str = "qwen3-livetranslate-flash-realtime";
pub const ASR_MODEL: &str = "qwen3-asr-flash-realtime";
/// The service's own default; any name from the Model Studio voice list works.
pub const VOICE: &str = "Tina";

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Region {
    #[default]
    Beijing,
    Singapore,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub api_key: String,
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
    #[serde(default = "default_model")]
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
fn default_model() -> String {
    MODEL_QWEN3_5.into()
}
fn default_voice() -> String {
    VOICE.into()
}
fn en() -> String {
    "en".into()
}

impl Settings {
    pub fn ws_url(&self) -> String {
        let ws = self.workspace_id.trim();
        let host = match (self.region, ws.is_empty()) {
            (Region::Beijing, true) => "dashscope.aliyuncs.com".to_string(),
            (Region::Beijing, false) => format!("{ws}.cn-beijing.maas.aliyuncs.com"),
            (Region::Singapore, true) => "dashscope-intl.aliyuncs.com".to_string(),
            (Region::Singapore, false) => format!("{ws}.ap-southeast-1.maas.aliyuncs.com"),
        };
        let model = if self.model.is_empty() { MODEL_QWEN3_5 } else { &self.model };
        format!("wss://{host}/api-ws/v1/realtime?model={model}")
    }

    /// The `session.update` payload. Text always (it drives the subtitles); audio on top when
    /// speaking, which arrives as 24 kHz mono PCM16 in `response.audio.delta`.
    pub fn session_update(&self) -> serde_json::Value {
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
        if self.model == MODEL_QWEN3_8 {
            return serde_json::json!({
                "type": "session.update",
                "session": {
                    "output_modalities": if self.speak { vec!["text", "audio"] } else { vec!["text"] },
                    "translation": translation,
                    "audio": {
                        "input": { "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.2,
                            "silence_duration_ms": 800
                        } },
                        // The public endpoint can inherit Chelsie even in text-only mode.
                        // Always specify Tina so the first audio input is not rejected.
                        "output": { "voice": VOICE }
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

    fn s(region: Region, workspace_id: &str) -> Settings {
        Settings {
            api_key: "k".into(),
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
        assert!(s(Region::Beijing, "  ").ws_url().starts_with("wss://dashscope.aliyuncs.com/"));
        assert!(s(Region::Singapore, "")
            .ws_url()
            .starts_with("wss://dashscope-intl.aliyuncs.com/"));
    }

    #[test]
    fn url_uses_dedicated_domain_with_workspace() {
        assert!(s(Region::Beijing, "llm-abc")
            .ws_url()
            .starts_with("wss://llm-abc.cn-beijing.maas.aliyuncs.com/"));
        assert!(s(Region::Singapore, "llm-abc")
            .ws_url()
            .starts_with("wss://llm-abc.ap-southeast-1.maas.aliyuncs.com/"));
    }

    #[test]
    fn url_carries_the_selected_model() {
        assert!(s(Region::Beijing, "").ws_url().ends_with(&format!("?model={MODEL_QWEN3_5}")));

        let mut qwen3 = s(Region::Beijing, "");
        qwen3.model = MODEL_QWEN3.into();
        assert!(qwen3.ws_url().ends_with(&format!("?model={MODEL_QWEN3}")));
    }

    #[test]
    fn empty_model_falls_back_to_qwen3_5() {
        let mut blank = s(Region::Beijing, "");
        blank.model = String::new();
        assert!(blank.ws_url().ends_with(&format!("?model={MODEL_QWEN3_5}")));
    }

    #[test]
    fn turn_detection_is_configured_not_empty() {
        let vad = &s(Region::Beijing, "").session_update()["session"]["turn_detection"];
        assert_eq!(vad["type"], "server_vad");
        assert!(vad["silence_duration_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn no_hotwords_omits_corpus() {
        let translation = &s(Region::Beijing, "").session_update()["session"]["translation"];
        assert_eq!(translation["language"], "en");
        assert!(translation.get("corpus").is_none());
    }

    #[test]
    fn hotwords_go_under_translation_corpus_phrases() {
        let mut with = s(Region::Beijing, "");
        with.hotwords.insert("人工智能".into(), "Artificial Intelligence".into());
        let phrases = &with.session_update()["session"]["translation"]["corpus"]["phrases"];
        assert_eq!(phrases["人工智能"], "Artificial Intelligence");
    }

    #[test]
    fn speaking_adds_the_audio_modality_and_voice() {
        let quiet = s(Region::Beijing, "").session_update();
        assert_eq!(quiet["session"]["modalities"], serde_json::json!(["text"]));
        assert!(quiet["session"].get("voice").is_none());

        let mut loud = s(Region::Beijing, "");
        loud.speak = true;
        loud.voice = "Ethan".into();
        let session = &loud.session_update()["session"];
        assert_eq!(session["modalities"], serde_json::json!(["text", "audio"]));
        assert_eq!(session["voice"], "Ethan");
        assert_eq!(session["output_audio_format"], "pcm");
    }

    #[test]
    fn auto_source_omits_language_field() {
        let v = s(Region::Beijing, "").session_update();
        assert!(v["session"]["input_audio_transcription"].get("language").is_none());

        let mut fixed = s(Region::Beijing, "");
        fixed.source_lang = "zh".into();
        assert_eq!(fixed.session_update()["session"]["input_audio_transcription"]["language"], "zh");
    }

    #[test]
    fn qwen3_8_uses_its_own_session_schema_and_endpoint_model() {
        let mut settings = s(Region::Beijing, "llm-abc");
        settings.model = MODEL_QWEN3_8.into();
        settings.voice = "Chelsie".into();
        settings.hotwords.insert("人工智能".into(), "AI".into());
        assert!(settings.ws_url().ends_with(&format!("?model={MODEL_QWEN3_8}")));
        let update = settings.session_update();
        let session = &update["session"];
        assert_eq!(session["output_modalities"], serde_json::json!(["text"]));
        assert_eq!(session["audio"]["output"]["voice"], "Tina");
        assert_eq!(
            session["audio"]["input"]["turn_detection"],
            s(Region::Beijing, "").session_update()["session"]["turn_detection"]
        );
        assert_eq!(session["translation"]["corpus"]["phrases"]["人工智能"], "AI");
        for old_field in ["modalities", "input_audio_transcription", "turn_detection", "voice", "input_audio_format"] {
            assert!(session.get(old_field).is_none(), "unexpected field: {old_field}");
        }
        settings.speak = true;
        assert_eq!(settings.session_update()["session"]["output_modalities"], serde_json::json!(["text", "audio"]));
        assert_eq!(settings.session_update()["session"]["audio"]["output"]["voice"], "Tina");
        settings.workspace_id.clear();
        assert_eq!(settings.ws_url(), format!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={MODEL_QWEN3_8}"));
        settings.region = Region::Singapore;
        assert_eq!(settings.ws_url(), format!("wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model={MODEL_QWEN3_8}"));
    }
}
