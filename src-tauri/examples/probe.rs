//! Wire-level probe: push a local audio file at the realtime endpoint and print every
//! server frame verbatim. This is how the event names and field shapes get verified against
//! the live service instead of guessed from the docs.
//!
//!   set DASHSCOPE_API_KEY=sk-...
//!   cargo run --example probe -- path\to\audio.wav [target_lang]

use realingo_lib::config::{Region, Settings};
use realingo_lib::decode;

use base64::prelude::{Engine, BASE64_STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("usage: probe <audio file> [target lang]");
    let target = std::env::args().nth(2).unwrap_or_else(|| "zh".into());
    let api_key = std::env::var("DASHSCOPE_API_KEY").expect("set DASHSCOPE_API_KEY");

    let settings = Settings {
        api_key,
        workspace_id: String::new(),
        region: Region::Beijing,
        source_lang: "auto".into(),
        target_lang: target,
        model: realingo_lib::config::MODEL.into(),
        hotwords: Default::default(),
    };

    println!("→ {}", settings.ws_url());
    let mut request = settings.ws_url().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", settings.api_key))?,
    );

    let (ws, response) = tokio_tungstenite::connect_async(request).await?;
    println!("← handshake {}", response.status());

    let (mut write, mut read) = ws.split();
    let update = settings.session_update();
    println!("→ {update}");
    write.send(Message::Text(update.to_string().into())).await?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<i16>>(64);
    let stop = Arc::new(AtomicBool::new(false));
    let file = std::path::PathBuf::from(path);
    std::thread::spawn(move || {
        if let Err(e) = decode::stream_file(&file, tx, stop, |_, _| {}) {
            eprintln!("decode: {e}");
        }
    });

    let uplink = tokio::spawn(async move {
        let mut chunks = 0u32;
        while let Some(chunk) = rx.recv().await {
            let mut bytes = Vec::with_capacity(chunk.len() * 2);
            for s in &chunk {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let frame = json!({
                "type": "input_audio_buffer.append",
                "audio": BASE64_STANDARD.encode(&bytes),
            });
            if write.send(Message::Text(frame.to_string().into())).await.is_err() {
                return;
            }
            chunks += 1;
        }
        eprintln!("[uplink] sent {chunks} chunks ({}s of audio)", chunks / 10);
        let _ = write.send(Message::Text(json!({ "type": "session.finish" }).to_string().into())).await;
    });

    let idle = std::time::Duration::from_secs(20);
    while let Ok(Some(Ok(msg))) = tokio::time::timeout(idle, read.next()).await {
        match msg {
            Message::Text(t) => println!("← {t}"),
            Message::Close(c) => {
                println!("← close {c:?}");
                break;
            }
            _ => {}
        }
    }
    let _ = uplink.await;
    Ok(())
}
