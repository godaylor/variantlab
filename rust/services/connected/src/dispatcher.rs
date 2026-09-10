use serde_json::Value;
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::config::Config;

const STREAM: &str = "variantlab:m8:render-jobs";

pub async fn run(config: Config) -> Result<(), String> {
    let pool = config.pool().await.map_err(|error| error.to_string())?;
    let redis = redis::Client::open(config.redis_url.clone()).map_err(|error| error.to_string())?;
    loop {
        let _: i32 = sqlx::query_scalar("SELECT variantlab_requeue_expired_jobs(20)")
            .fetch_one(&pool)
            .await
            .map_err(|error| error.to_string())?;
        let rows = sqlx::query(
            "SELECT event_id,event_tenant_id,aggregate_id,payload FROM variantlab_claim_outbox($1,50)",
        )
        .bind(&config.worker_id)
        .fetch_all(&pool)
        .await
        .map_err(|error| error.to_string())?;
        if rows.is_empty() {
            sleep(Duration::from_millis(250)).await;
            continue;
        }
        let mut connection = redis
            .get_multiplexed_async_connection()
            .await
            .map_err(|error| error.to_string())?;
        for row in rows {
            let event_id: i64 = row.get("event_id");
            let tenant_id: String = row.get("event_tenant_id");
            let job_id: String = row.get("aggregate_id");
            let payload: Value = row.get("payload");
            let _: String = redis::cmd("XADD")
                .arg(STREAM)
                .arg("*")
                .arg("event_id")
                .arg(event_id)
                .arg("tenant_id")
                .arg(&tenant_id)
                .arg("job_id")
                .arg(&job_id)
                .arg("payload")
                .arg(payload.to_string())
                .query_async(&mut connection)
                .await
                .map_err(|error| error.to_string())?;
            let _: bool = sqlx::query_scalar("SELECT variantlab_mark_outbox_published($1,$2)")
                .bind(event_id)
                .bind(&config.worker_id)
                .fetch_one(&pool)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
}
