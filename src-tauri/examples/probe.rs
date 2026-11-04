//! Wire-level probe: push a local audio file at the realtime endpoint and print every
//! server frame verbatim. This is how the event names and field shapes get verified against
//! the live service instead of guessed from the docs.
//!
//!   set DASHSCOPE_API_KEY=sk-...
//!   cargo run --example probe -- path\to\audio.wav [target_lang] [model]
//!   set DASHSCOPE_WORKSPACE_ID=llm-...   (optional dedicated endpoint)
//!   set OPENAI_API_KEY=sk-...            (instead: probe OpenAI gpt-realtime-translate)
//!   set GEMINI_API_KEY=AIza...           (instead: probe Gemini Live Translate)
//!   set VOLC_API_KEY=...                 (instead: probe Volcengine AST; PROBE_SOURCE=zh, PROBE_TWO_WAY=1)
//!   set PROBE_PROTOCOL=qwen38            (qwen35 | qwen38 | openai | gemini | volc; default follows the key)

use realingo_lib::config::{Protocol, Settings};
use realingo_lib::decode;

use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("usage: probe <audio file> [target lang] [model]");
    let env = |k: &str| std::env::var(k).unwrap_or_default();

    // Every other field keeps the app's own default.
    let mut settings: Settings = serde_json::from_value(serde_json::json!({}))?;
    settings.api_key = env("DASHSCOPE_API_KEY");
    settings.openai_key = env("OPENAI_API_KEY");
    settings.gemini_key = env("GEMINI_API_KEY");
    settings.volc_key = env("VOLC_API_KEY");
    settings.protocol = match env("PROBE_PROTOCOL") {
        // The same names the app stores, parsed by the same serde derive.
        name if !name.is_empty() => serde_json::from_value(serde_json::json!(name))?,
        _ if !settings.volc_key.is_empty() => Protocol::Volc,
        _ if !settings.gemini_key.is_empty() => Protocol::Gemini,
        _ if !settings.openai_key.is_empty() => Protocol::Openai,
        _ => Protocol::Qwen35,
    };
    assert!(!settings.key().is_empty(), "set DASHSCOPE_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY");
    settings.url = env("PROBE_URL");
    settings.workspace_id = env("DASHSCOPE_WORKSPACE_ID");
    settings.target_lang = std::env::args().nth(2).unwrap_or_else(|| "zh".into());
    if let Ok(source) = std::env::var("PROBE_SOURCE") {
        settings.source_lang = source;
    }
    settings.two_way = std::env::var_os("PROBE_TWO_WAY").is_some();
    // Empty falls back to the protocol's default model.
    settings.model = std::env::args().nth(3).unwrap_or_default();
    // set PROBE_SPEAK=1 to see the audio-modality frames too.
    settings.speak = std::env::var_os("PROBE_SPEAK").is_some();
    if let Ok(voice) = std::env::var("PROBE_VOICE") {
        settings.voice = voice;
    }

    // The URL as Settings shows it: for Gemini that is without the key.
    println!("→ {}", settings.ws_url());
    let (ws, response) = tokio_tungstenite::connect_async(settings.client_request()?).await?;
    println!("← handshake {}", response.status());

    let (mut write, mut read) = ws.split();
    let session = "probe-session".to_string();
    let setup = settings.setup_message(&session);
    println!("→ {setup:?}");
    write.send(setup).await?;

    let idle = std::time::Duration::from_secs(20);
    // Every frame as the JSON the app reads (Gemini sends JSON in binary frames, Volc
    // protobuf), with Volc's TTS audio cut down to its size: base64 is no use on screen.
    let reader = settings.clone();
    let as_json = move |msg: &Message| -> Option<serde_json::Value> {
        let mut v = match msg {
            Message::Text(t) => serde_json::from_str(t.as_str()).ok()?,
            Message::Binary(b) => reader.decode_binary(b)?,
            _ => return None,
        };
        if let Some(n) = v.get("data").and_then(|d| d.as_str()).map(str::len) {
            v["data"] = format!("<{n} b64 chars>").into();
        }
        Some(v)
    };
    if settings.waits_for_setup() {
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(idle, read.next()).await {
            if let Message::Close(c) = &msg {
                println!("← close {c:?}");
                return Ok(());
            }
            let Some(v) = as_json(&msg) else { continue };
            println!("← {v}");
            if settings.is_ready(&v) {
                break;
            }
        }
    }

    let rate = settings.sample_rate();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
    let stop = Arc::new(AtomicBool::new(false));
    let file = std::path::PathBuf::from(path);
    std::thread::spawn(move || {
        if let Err(e) = decode::stream_file(&file, rate, tx, stop, |_, _| {}) {
            eprintln!("decode: {e}");
        }
    });

    let (wire, sid) = (settings.clone(), session.clone());
    let uplink = tokio::spawn(async move {
        let mut chunks = 0u32;
        while let Some(chunk) = rx.recv().await {
            let mut bytes = Vec::with_capacity(chunk.len() * 2);
            for s in &chunk {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            if write.send(wire.audio_message(&sid, bytes)).await.is_err() {
                return;
            }
            chunks += 1;
        }
        eprintln!("[uplink] sent {chunks} chunks ({}s of audio)", chunks / 10);
        let _ = write.send(wire.finish_message(&sid)).await;
    });

    while let Ok(Some(Ok(msg))) = tokio::time::timeout(idle, read.next()).await {
        if let Message::Close(c) = &msg {
            println!("← close {c:?}");
            break;
        }
        if let Some(t) = as_json(&msg) {
            println!("← {t}");
        }
    }
    let _ = uplink.await;
    Ok(())
}
