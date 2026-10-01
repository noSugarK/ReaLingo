//! ASR-only session configuration. No translation settings are sent to this endpoint.
use serde_json::{json, Value};

pub fn session_update(language: &str) -> Value {
    let mut session = json!({
        "input_audio_format": "pcm",
        "sample_rate": 16000,
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.2,
            "silence_duration_ms": 800
        }
    });
    if !language.is_empty() && language != "auto" {
        session["input_audio_transcription"] = json!({ "language": language });
    }
    json!({ "event_id": "session_config", "type": "session.update", "session": session })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_recognition_sends_no_language_or_translation() {
        let value = session_update("auto");
        let session = &value["session"];
        assert!(session.get("translation").is_none());
        assert!(session.get("input_audio_transcription").is_none());
        assert_eq!(session["sample_rate"], 16000);
    }

    #[test]
    fn known_language_is_an_asr_hint_only() {
        let value = session_update("zh");
        assert_eq!(value["session"]["input_audio_transcription"]["language"], "zh");
        assert!(value["session"].get("translation").is_none());
    }
}
