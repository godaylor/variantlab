use std::{env, net::SocketAddr, str::FromStr, time::Duration};

use aws_config::{BehaviorVersion, Region};
use aws_credential_types::Credentials;
use aws_sdk_s3::{Client as S3Client, config::Builder as S3ConfigBuilder};
use sqlx::{PgPool, postgres::PgPoolOptions};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub database_admin_url: Option<String>,
    pub redis_url: String,
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub bff_secret: String,
    pub public_api_url: String,
    pub mode: String,
    pub worker_id: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let required = |name: &str| {
            env::var(name).map_err(|_| format!("required environment variable {name} is missing"))
        };
        Ok(Self {
            bind: SocketAddr::from_str(
                &env::var("VARIANTLAB_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            )
            .map_err(|error| format!("invalid VARIANTLAB_BIND: {error}"))?,
            database_url: required("DATABASE_URL")?,
            database_admin_url: env::var("DATABASE_ADMIN_URL").ok(),
            redis_url: required("REDIS_URL")?,
            s3_endpoint: required("S3_ENDPOINT")?,
            s3_region: env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
            s3_bucket: env::var("S3_BUCKET").unwrap_or_else(|_| "variantlab-m8".into()),
            s3_access_key: required("S3_ACCESS_KEY")?,
            s3_secret_key: required("S3_SECRET_KEY")?,
            bff_secret: required("VARIANTLAB_BFF_SECRET")?,
            public_api_url: env::var("VARIANTLAB_PUBLIC_API_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:32201".into()),
            mode: env::var("VARIANTLAB_MODE").unwrap_or_else(|_| "api".into()),
            worker_id: env::var("VARIANTLAB_WORKER_ID")
                .unwrap_or_else(|_| format!("worker-{}", std::process::id())),
        })
    }

    pub async fn pool(&self) -> Result<PgPool, sqlx::Error> {
        PgPoolOptions::new()
            .max_connections(12)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&self.database_url)
            .await
    }

    pub async fn admin_pool(&self) -> Result<PgPool, String> {
        let url = self
            .database_admin_url
            .as_ref()
            .ok_or_else(|| "DATABASE_ADMIN_URL is required in migrate mode".to_owned())?;
        PgPoolOptions::new()
            .max_connections(1)
            .connect(url)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn s3(&self) -> S3Client {
        let shared = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(self.s3_region.clone()))
            .credentials_provider(Credentials::new(
                self.s3_access_key.clone(),
                self.s3_secret_key.clone(),
                None,
                None,
                "variantlab-m8-compose",
            ))
            .endpoint_url(self.s3_endpoint.clone())
            .load()
            .await;
        let config = S3ConfigBuilder::from(&shared)
            .force_path_style(true)
            .build();
        S3Client::from_conf(config)
    }

    pub async fn public_s3(&self) -> S3Client {
        let mut public = self.clone();
        public.s3_endpoint =
            env::var("S3_PUBLIC_ENDPOINT").unwrap_or_else(|_| self.s3_endpoint.clone());
        public.s3().await
    }
}
