mod api;
mod config;
mod dispatcher;
mod identity;
mod job_api;
mod native_render;
mod review_api;
mod sync_api;
mod upload_api;
mod worker;

use config::Config;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    match config.mode.as_str() {
        "api" => api::serve(config).await,
        "dispatcher" | "worker" => {
            // Transient Redis/DB outages must not require an operator restart.
            // Durable leases/outbox records recover interrupted work. Never log
            // provider error text, which can include URLs or credentials.
            loop {
                let result = if config.mode == "dispatcher" {
                    dispatcher::run(config.clone()).await
                } else {
                    worker::run(config.clone()).await
                };
                if result.is_ok() {
                    return Ok(());
                }
                tracing::warn!(component = %config.mode, "connected dependency unavailable; retrying");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
        "migrate" => {
            let pool = config.admin_pool().await?;
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        mode => Err(format!("unsupported VARIANTLAB_MODE {mode}")),
    }
}
