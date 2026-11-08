use std::convert::Infallible;

use bytes::Bytes;
use futures_util::{stream, StreamExt};
use http_body_util::{BodyExt, Empty, Full};
use hyper::{server::conn::http1, service::service_fn, Request, Response, StatusCode};
use hyper_util::{
    client::legacy::Client,
    rt::{TokioExecutor, TokioIo},
};
use tokio::net::TcpListener;

const BODY: &[u8] = b"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("server") {
        let listener = TcpListener::bind("127.0.0.1:18080").await?;
        loop {
            let (socket, _) = listener.accept().await?;
            socket.set_nodelay(true)?;
            tokio::spawn(async move {
                let service = service_fn(|_| async {
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(BODY))))
                });
                if let Err(error) = http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await
                {
                    eprintln!("{error}");
                }
            });
        }
    }

    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new())
        .pool_max_idle_per_host(16)
        .build_http();
    // Match sendAll's ownership: prepare the batch, then retain every response until validation.
    let batch: Vec<_> = (0..4096)
        .map(|_| {
            Request::builder()
                .uri("http://127.0.0.1:18080/payload")
                .body(Empty::new())
                .unwrap()
        })
        .collect();
    let requests = stream::iter(batch).map(|request| {
        let client = &client;
        async move {
            let response = client.request(request).await.unwrap();
            let (parts, body) = response.into_parts();
            let body = body.collect().await.unwrap().to_bytes();
            Response::from_parts(parts, body)
        }
    });
    let responses: Vec<_> = requests.buffer_unordered(16).collect().await;
    assert_eq!(responses.len(), 4096);
    let mut checksum = 0;
    for response in &responses {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(&response.body()[..], BODY);
        checksum += response
            .body()
            .iter()
            .map(|&byte| usize::from(byte))
            .sum::<usize>();
    }
    assert_eq!(checksum, 4096 * 32 * 120);
    Ok(())
}
