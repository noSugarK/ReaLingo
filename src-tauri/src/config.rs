use serde::{Deserialize, Serialize};

pub const MODEL: &str = "qwen3.5-livetranslate-flash-realtime";
/// The previous generation. Same protocol, but only 18 languages — the UI narrows the
/// pickers accordingly so a session cannot be opened with a target it will reject.
pub const MODEL_LEGACY: &str = "qwen3-livetranslate-flash-realtime";
pub const ASR_MODEL: &str = "qwen3-asr-flash-realtime";

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
}

fn auto() -> String {
    "auto".into()
}
fn default_model() -> String {
    MODEL.into()
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
        let model = if self.model.is_empty() { MODEL } else { &self.model };
        format!("wss://{host}/api-ws/v1/realtime?model={model}")
    }

    /// The `session.update` payload. Text-only: we render subtitles, we don't speak.
    pub fn session_update(&self) -> serde_json::Value {
        let mut transcription = serde_json::json!({ "model": ASR_MODEL });
        // Omitting `language` is what tells the model to auto-detect the source.
        if self.source_lang != "auto" && !self.source_lang.is_empty() {
            transcription["language"] = self.source_lang.clone().into();
        }
        serde_json::json!({
            "type": "session.update",
            "session": {
                "modalities": ["text"],
                "input_audio_format": "pcm",
                // ponytail: session-scoped and immutable. Sending a second `session.update`
                // to retarget a live session is rejected with "session already started or
                // finished or failed" AND closes the socket — verified against the endpoint
                // with examples/probe.rs. Two-way translation therefore needs two parallel
                // sessions (one per direction), not a mid-flight switch. See README.
                "translation": { "language": self.target_lang },
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
        })
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
            model: MODEL.into(),
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
        assert!(s(Region::Beijing, "").ws_url().ends_with(&format!("?model={MODEL}")));

        let mut legacy = s(Region::Beijing, "");
        legacy.model = MODEL_LEGACY.into();
        assert!(legacy.ws_url().ends_with(&format!("?model={MODEL_LEGACY}")));
    }

    #[test]
    fn empty_model_falls_back_to_the_current_one() {
        let mut blank = s(Region::Beijing, "");
        blank.model = String::new();
        assert!(blank.ws_url().ends_with(&format!("?model={MODEL}")));
    }

    #[test]
    fn turn_detection_is_configured_not_empty() {
        let vad = &s(Region::Beijing, "").session_update()["session"]["turn_detection"];
        assert_eq!(vad["type"], "server_vad");
        assert!(vad["silence_duration_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn auto_source_omits_language_field() {
        let v = s(Region::Beijing, "").session_update();
        assert!(v["session"]["input_audio_transcription"].get("language").is_none());

        let mut fixed = s(Region::Beijing, "");
        fixed.source_lang = "zh".into();
        assert_eq!(fixed.session_update()["session"]["input_audio_transcription"]["language"], "zh");
    }
}
