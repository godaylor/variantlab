use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityClaims {
    pub tenant_id: String,
    pub actor_id: String,
    pub role: String,
    pub expires_at_unix: i64,
    pub nonce: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("signed BFF identity is missing")]
    Missing,
    #[error("signed BFF identity is malformed")]
    Malformed,
    #[error("signed BFF identity signature is invalid")]
    InvalidSignature,
    #[error("signed BFF identity is expired or unreasonably long-lived")]
    Expired,
    #[error("signed BFF identity contains an unsupported role")]
    InvalidRole,
}

pub fn verify(headers: &HeaderMap, secret: &[u8]) -> Result<IdentityClaims, IdentityError> {
    verify_at(headers, secret, Utc::now().timestamp())
}

fn verify_at(
    headers: &HeaderMap,
    secret: &[u8],
    now_unix: i64,
) -> Result<IdentityClaims, IdentityError> {
    let encoded = headers
        .get("x-variantlab-identity")
        .and_then(|value| value.to_str().ok())
        .ok_or(IdentityError::Missing)?;
    let signature = headers
        .get("x-variantlab-signature")
        .and_then(|value| value.to_str().ok())
        .ok_or(IdentityError::Missing)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| IdentityError::Malformed)?;
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| IdentityError::Malformed)?;
    mac.update(encoded.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| IdentityError::InvalidSignature)?;
    let payload = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| IdentityError::Malformed)?;
    let claims: IdentityClaims =
        serde_json::from_slice(&payload).map_err(|_| IdentityError::Malformed)?;
    if claims.tenant_id.trim().is_empty()
        || claims.actor_id.trim().is_empty()
        || claims.nonce.len() < 16
    {
        return Err(IdentityError::Malformed);
    }
    if claims.expires_at_unix < now_unix || claims.expires_at_unix > now_unix + 300 {
        return Err(IdentityError::Expired);
    }
    if !matches!(claims.role.as_str(), "owner" | "operator" | "reviewer") {
        return Err(IdentityError::InvalidRole);
    }
    Ok(claims)
}

pub fn personal_tenant_id(actor_id: &str) -> String {
    let digest = Sha256::digest(actor_id.as_bytes());
    format!("tenant-personal-{}", hex::encode(digest)[..24].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn signed_headers(claims: &IdentityClaims, secret: &[u8]) -> HeaderMap {
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(encoded.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-variantlab-identity",
            HeaderValue::from_str(&encoded).unwrap(),
        );
        headers.insert(
            "x-variantlab-signature",
            HeaderValue::from_str(&signature).unwrap(),
        );
        headers
    }

    #[test]
    fn accepts_only_short_lived_untampered_identity() {
        let secret = b"test-secret-with-enough-entropy";
        let claims = IdentityClaims {
            tenant_id: personal_tenant_id("actor-a"),
            actor_id: "actor-a".into(),
            role: "owner".into(),
            expires_at_unix: 1_000,
            nonce: "nonce-0123456789".into(),
        };
        let mut headers = signed_headers(&claims, secret);
        assert_eq!(verify_at(&headers, secret, 900), Ok(claims));
        headers.insert(
            "x-variantlab-signature",
            HeaderValue::from_static("tampered"),
        );
        assert_eq!(
            verify_at(&headers, secret, 900),
            Err(IdentityError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_expired_or_cross_actor_personal_tenant_claims() {
        let secret = b"test-secret-with-enough-entropy";
        let claims = IdentityClaims {
            tenant_id: personal_tenant_id("actor-a"),
            actor_id: "actor-a".into(),
            role: "owner".into(),
            expires_at_unix: 800,
            nonce: "nonce-0123456789".into(),
        };
        assert_eq!(
            verify_at(&signed_headers(&claims, secret), secret, 900),
            Err(IdentityError::Expired)
        );
        assert_ne!(personal_tenant_id("actor-a"), personal_tenant_id("actor-b"));
    }
}
