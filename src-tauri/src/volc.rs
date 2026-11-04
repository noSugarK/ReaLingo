//! Volcengine Doubao simultaneous interpretation (AST v2): protobuf over binary WebSocket frames.
//!
//! Only the fields this app sends or reads are declared, with the official tags from
//! `products/understanding/ast/ast_service.proto` and friends; protobuf skips the rest. Hand
//! written with `prost` derives so the build needs no `protoc`.

use base64::prelude::{Engine, BASE64_STANDARD};
use prost::Message;
use serde_json::{json, Value};

use crate::config::Settings;

pub const URL: &str = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
pub const RESOURCE_ID: &str = "volc.service_type.10053";
/// The voice setting that asks for the speaker's own voice to be cloned: the service clones
/// whenever no preset is named. Mirrors `VOLC_VOICES` in src/languages.ts.
pub const CLONE: &str = "clone";
/// The preset voices, which speak only Chinese and English. Mirrors `VOLC_VOICES`.
pub const VOICES: [&str; 2] = ["zh_female_vv_uranus_bigtts", "zh_male_jingqiangkanye_emo_mars_bigtts"];

/// `common/events.proto`, the values this protocol uses.
mod event {
    pub const START_SESSION: i32 = 100;
    pub const FINISH_SESSION: i32 = 102;
    pub const TASK_REQUEST: i32 = 200;
}

#[derive(Clone, PartialEq, Message)]
struct RequestMeta {
    #[prost(string, tag = "6")]
    session_id: String,
}

#[derive(Clone, PartialEq, Message)]
struct Audio {
    #[prost(string, tag = "4")]
    format: String,
    #[prost(string, tag = "5")]
    codec: String,
    #[prost(int32, tag = "7")]
    rate: i32,
    #[prost(int32, tag = "8")]
    bits: i32,
    #[prost(int32, tag = "9")]
    channel: i32,
    #[prost(bytes = "vec", tag = "14")]
    binary_data: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct ReqParams {
    #[prost(string, tag = "1")]
    mode: String,
    #[prost(string, tag = "2")]
    source_language: String,
    #[prost(string, tag = "3")]
    target_language: String,
    #[prost(string, tag = "4")]
    speaker_id: String,
    /// Adds `detected_language` to SourceSubtitleEnd: which way a two-way sentence went.
    #[prost(bool, optional, tag = "6")]
    enable_source_language_detect: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
struct TranslateRequest {
    #[prost(message, optional, tag = "1")]
    request_meta: Option<RequestMeta>,
    #[prost(int32, tag = "2")]
    event: i32,
    #[prost(message, optional, tag = "4")]
    source_audio: Option<Audio>,
    #[prost(message, optional, tag = "5")]
    target_audio: Option<Audio>,
    #[prost(message, optional, tag = "6")]
    request: Option<ReqParams>,
}

#[derive(Clone, PartialEq, Message)]
struct ResponseMeta {
    #[prost(int32, tag = "3")]
    status_code: i32,
    #[prost(string, tag = "4")]
    message: String,
}

#[derive(Clone, PartialEq, Message)]
struct TranslateResponse {
    #[prost(message, optional, tag = "1")]
    response_meta: Option<ResponseMeta>,
    #[prost(int32, tag = "2")]
    event: i32,
    #[prost(bytes = "vec", tag = "3")]
    data: Vec<u8>,
    #[prost(string, tag = "4")]
    text: String,
    #[prost(int32, tag = "5")]
    start_time: i32,
    #[prost(int32, tag = "6")]
    end_time: i32,
    #[prost(string, optional, tag = "10")]
    detected_language: Option<String>,
}

fn request(session: &str, event: i32) -> TranslateRequest {
    TranslateRequest {
        request_meta: Some(RequestMeta { session_id: session.into() }),
        event,
        ..Default::default()
    }
}

/// StartSession: the whole session's configuration, fixed from here on.
pub fn start(settings: &Settings, session: &str) -> Vec<u8> {
    let mut req = request(session, event::START_SESSION);
    req.source_audio = Some(Audio {
        format: "wav".into(),
        codec: "raw".into(),
        rate: settings.sample_rate() as i32,
        bits: 16,
        channel: 1,
        ..Default::default()
    });
    req.target_audio = Some(Audio { format: "pcm".into(), rate: 24_000, ..Default::default() });
    // Two-way is Chinese–English only, spelled `zhen` on both sides.
    let (source, target) = if settings.two_way {
        ("zhen".to_string(), "zhen".to_string())
    } else {
        (settings.source_lang.clone(), settings.target_lang.clone())
    };
    // A preset only where it can speak the target; otherwise `CLONE` — asked for, or the
    // fallback for a preset that cannot speak this target (or a voice from another list).
    let preset = VOICES.contains(&settings.voice.as_str()) && matches!(target.as_str(), "zh" | "en" | "zhen");
    req.request = Some(ReqParams {
        mode: if settings.speak { "s2s" } else { "s2t" }.into(),
        source_language: source,
        target_language: target,
        speaker_id: if preset { settings.voice.clone() } else { String::new() },
        enable_source_language_detect: Some(true),
    });
    req.encode_to_vec()
}

pub fn audio(session: &str, pcm: Vec<u8>) -> Vec<u8> {
    let mut req = request(session, event::TASK_REQUEST);
    req.source_audio = Some(Audio { binary_data: pcm, ..Default::default() });
    req.encode_to_vec()
}

pub fn finish(session: &str) -> Vec<u8> {
    request(session, event::FINISH_SESSION).encode_to_vec()
}

fn event_name(event: i32) -> &'static str {
    match event {
        150 => "SessionStarted",
        151 => "SessionCanceled",
        152 => "SessionFinished",
        153 => "SessionFailed",
        154 => "UsageResponse",
        250 => "AudioMuted",
        350 => "TTSSentenceStart",
        351 => "TTSSentenceEnd",
        352 => "TTSResponse",
        650 => "SourceSubtitleStart",
        651 => "SourceSubtitleResponse",
        652 => "SourceSubtitleEnd",
        653 => "TranslationSubtitleStart",
        654 => "TranslationSubtitleResponse",
        655 => "TranslationSubtitleEnd",
        _ => "Unknown",
    }
}

/// One server frame as JSON, so it rides the same path as every other protocol: the raw log,
/// `take_audio` (audio goes under `data`, base64) and `TextStream`. The event goes in `type`
/// like everyone else's, prefixed so it cannot collide with theirs: `volc.SessionStarted`.
pub fn decode(bytes: &[u8]) -> Option<Value> {
    let r = TranslateResponse::decode(bytes).ok()?;
    let meta = r.response_meta.unwrap_or_default();
    let mut v = json!({
        "type": format!("volc.{}", event_name(r.event)),
        "text": r.text,
        "start_time": r.start_time,
        "end_time": r.end_time,
        "status_code": meta.status_code,
        "message": meta.message,
    });
    if let Some(lang) = r.detected_language {
        v["detected_language"] = lang.into();
    }
    if !r.data.is_empty() {
        v["data"] = BASE64_STANDARD.encode(f32_to_i16(&r.data)).into();
    }
    Some(v)
}

/// 24 kHz PCM comes as 32-bit float (per the docs, and the byte count of a live session
/// only adds up that way); the player, like every other protocol's audio, is PCM16.
fn f32_to_i16(bytes: &[u8]) -> Vec<u8> {
    bytes
        .chunks_exact(4)
        .flat_map(|b| {
            let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]).clamp(-1.0, 1.0);
            ((s * 32767.0) as i16).to_le_bytes()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_response_decodes_into_the_json_the_stream_reads() {
        let bytes = TranslateResponse {
            event: 652,
            text: "你好".into(),
            start_time: 1200,
            end_time: 2400,
            data: [0.5f32, -1.0].iter().flat_map(|s| s.to_le_bytes()).collect(),
            ..Default::default()
        }
        .encode_to_vec();
        let v = decode(&bytes).unwrap();
        assert_eq!(v["type"], "volc.SourceSubtitleEnd");
        assert_eq!((v["text"].as_str(), v["start_time"].as_i64()), (Some("你好"), Some(1200)));
        // f32 in, PCM16 out.
        let pcm: Vec<u8> = [16383i16, -32767].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(v["data"], BASE64_STANDARD.encode(pcm));
    }

    #[test]
    fn audio_rides_in_source_audio_binary_data() {
        let req = TranslateRequest::decode(audio("s1", vec![7, 8]).as_slice()).unwrap();
        assert_eq!(req.event, event::TASK_REQUEST);
        assert_eq!(req.request_meta.unwrap().session_id, "s1");
        assert_eq!(req.source_audio.unwrap().binary_data, vec![7, 8]);
    }

    #[test]
    fn a_preset_voice_is_named_only_where_it_can_speak_the_target() {
        let speaker = |voice: &str, target: &str| {
            let settings: Settings = serde_json::from_value(json!({ "protocol": "volc", "voice": voice, "sourceLang": "en", "targetLang": target, "speak": true })).unwrap();
            TranslateRequest::decode(start(&settings, "s").as_slice()).unwrap().request.unwrap().speaker_id
        };
        assert_eq!(speaker(VOICES[0], "zh"), VOICES[0]);
        assert_eq!(speaker(VOICES[0], "ja"), "");
        assert_eq!(speaker(CLONE, "zh"), "");
        assert_eq!(speaker("Tina", "zh"), "");
    }
}
