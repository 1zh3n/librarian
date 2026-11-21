use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, StatusCode},
    routing::post,
    Json, Router,
};
use hmac::{Hmac, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use super::{
    accounts::administrator,
    ai_configuration,
    ai_provider::{self, AddressPolicy, DiscoveredModel},
    contract::ApiError,
    db::Metadata,
    documents::{run, DocumentService},
};

const TICKET_LIFETIME: Duration = Duration::from_secs(600);
const MAX_LIVE_TICKETS: usize = 128;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoveredCatalog {
    pub fetched_at: i64,
    pub models: Vec<DiscoveredModel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    discovery_id: String,
    #[serde(flatten)]
    catalog: DiscoveredCatalog,
}

struct Ticket {
    expires_at: Instant,
    catalog: DiscoveredCatalog,
}

struct Tickets {
    fingerprint_key: [u8; 32],
    live: Mutex<HashMap<[u8; 32], Ticket>>,
}

struct Draft<'a> {
    actor: &'a str,
    provider: &'a str,
    endpoint: &'a Url,
    key: &'a str,
}

impl Tickets {
    fn new() -> Result<Self, String> {
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|_| "Could not initialize AI discovery tickets")?;
        Ok(Self {
            fingerprint_key: key,
            live: Mutex::new(HashMap::new()),
        })
    }

    // Only this keyed lookup digest and the actual catalog are retained.
    fn lookup_key(&self, draft: &Draft<'_>, id: &str) -> [u8; 32] {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.fingerprint_key).expect("valid HMAC key");
        for field in [
            id,
            draft.actor,
            draft.provider,
            draft.endpoint.as_str(),
            draft.key,
        ] {
            mac.update(&(field.len() as u64).to_be_bytes());
            mac.update(field.as_bytes());
        }
        mac.finalize().into_bytes().into()
    }

    fn issue(
        &self,
        draft: &Draft<'_>,
        models: Vec<DiscoveredModel>,
        now: Instant,
    ) -> Result<Discovery, ApiError> {
        let mut live = self
            .live
            .lock()
            .map_err(|_| ApiError::internal("Discovery store unavailable"))?;
        live.retain(|_, t| t.expires_at > now);
        if live.len() >= MAX_LIVE_TICKETS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "discovery_limit",
                "Please retry after earlier discovery tickets expire",
            ));
        }
        let discovery_id = Uuid::new_v4().to_string();
        let catalog = DiscoveredCatalog {
            fetched_at: chrono::Utc::now().timestamp(),
            models,
        };
        live.insert(
            self.lookup_key(draft, &discovery_id),
            Ticket {
                expires_at: now + TICKET_LIFETIME,
                catalog: catalog.clone(),
            },
        );
        Ok(Discovery {
            discovery_id,
            catalog,
        })
    }

    fn catalog(&self, id: &str, draft: &Draft<'_>, now: Instant) -> Option<DiscoveredCatalog> {
        let digest = self.lookup_key(draft, id);
        self.live
            .lock()
            .ok()?
            .get(&digest)
            .filter(|t| t.expires_at > now)
            .map(|t| t.catalog.clone())
    }
}

pub(super) struct AiDiscoveryService {
    policy: AddressPolicy,
    tickets: Tickets,
}

impl AiDiscoveryService {
    pub(super) fn open(metadata: &Metadata) -> Result<Self, String> {
        Ok(Self {
            policy: AddressPolicy::load(metadata)?,
            tickets: Tickets::new()?,
        })
    }

    // Called by the connection writer (A2) after authenticating the current admin.
    pub(super) fn validate_discovery(
        &self,
        actor: &str,
        provider: &str,
        base_url: &str,
        key: &str,
        discovery_id: &str,
    ) -> Result<DiscoveredCatalog, ApiError> {
        let endpoint = ai_provider::normalize(base_url)?;
        let draft = Draft {
            actor,
            provider,
            endpoint: &endpoint,
            key,
        };
        self.tickets
            .catalog(discovery_id, &draft, Instant::now())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "discovery_invalid",
                    "Discover the models again for these settings",
                )
            })
    }

    // The managed runner connects to these addresses with the original TLS hostname.
    pub(super) async fn resolve_endpoint(
        &self,
        base_url: &str,
    ) -> Result<ai_provider::PinnedEndpoint, ApiError> {
        self.policy.resolve(ai_provider::normalize(base_url)?).await
    }
}

pub(super) fn routes() -> Router<Arc<DocumentService>> {
    Router::new().route("/ai/settings/discover", post(discover))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftDiscovery {
    provider: String,
    base_url: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedDiscovery {
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum DiscoveryInput {
    Draft(DraftDiscovery),
    Saved(SavedDiscovery),
}

async fn discover(
    State(service): State<Arc<DocumentService>>,
    request: Request,
) -> Result<Json<Discovery>, ApiError> {
    let (parts, body) = request.into_parts();
    let account = administrator(&service, &parts.headers, true)?;
    let content_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(';').next())
        .unwrap_or("")
        .trim();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(ApiError::invalid("Expected a JSON discovery request"));
    }
    let bytes = to_bytes(body, 16 * 1024).await.map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "discovery_request_too_large",
            "The discovery request exceeds the size limit",
        )
    })?;
    let input: DiscoveryInput = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::invalid("Expected a valid discovery request"))?;
    let input = match input {
        DiscoveryInput::Draft(input) => input,
        DiscoveryInput::Saved(saved) => {
            let read_service = Arc::clone(&service);
            let id = saved.connection_id;
            let read_id = id.clone();
            let credential =
                run(move || ai_configuration::saved_credential(&read_service, &read_id)).await?;
            let endpoint = ai_provider::normalize(&credential.base_url)?;
            let models =
                ai_provider::models(&service.ai_discovery.policy, &endpoint, &credential.api_key)
                    .await?;
            administrator(&service, &parts.headers, true)?;
            let catalog = DiscoveredCatalog {
                fetched_at: chrono::Utc::now().timestamp(),
                models,
            };
            // A saved connection refresh is applied here. Its receipt cannot authorize
            // creating a different connection with the stored credential.
            return run(move || {
                ai_configuration::refresh_catalog(&service, &id, credential.version, &catalog)?;
                Ok(Json(Discovery {
                    discovery_id: Uuid::new_v4().to_string(),
                    catalog,
                }))
            })
            .await;
        }
    };
    let key = input.api_key.as_str();
    if input.provider != "deepseek"
        || key.is_empty()
        || key.len() > 4096
        || !key.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(ApiError::invalid(
            "Provide a supported provider and a valid API key",
        ));
    }
    let endpoint = ai_provider::normalize(&input.base_url)?;
    let models = ai_provider::models(&service.ai_discovery.policy, &endpoint, key).await?;
    administrator(&service, &parts.headers, true)?;
    let draft = Draft {
        actor: account.username(),
        provider: &input.provider,
        endpoint: &endpoint,
        key,
    };
    service
        .ai_discovery
        .tickets
        .issue(&draft, models, Instant::now())
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_ticket_binds_the_admin_provider_endpoint_key_and_returned_catalog() {
        let store = Tickets::new().unwrap();
        let now = Instant::now();
        let endpoint = ai_provider::normalize("https://EXAMPLE.org:443/v1/").unwrap();
        let equivalent = ai_provider::normalize("https://example.org/v1").unwrap();
        let other = ai_provider::normalize("https://example.org").unwrap();
        let models = |id: &str| serde_json::from_value(serde_json::json!([{"id":id}])).unwrap();
        let issue = |key, id| {
            store
                .issue(
                    &Draft {
                        actor: "admin",
                        provider: "deepseek",
                        endpoint: &endpoint,
                        key,
                    },
                    models(id),
                    now,
                )
                .unwrap()
        };
        let first = issue("first-key", "first");
        let second = issue("second-key", "second");
        let read = |id: &str, admin, provider, url, key, time| {
            store.catalog(
                id,
                &Draft {
                    actor: admin,
                    provider,
                    endpoint: url,
                    key,
                },
                time,
            )
        };
        for (admin, provider, url, key) in [
            ("another-admin", "deepseek", &equivalent, "first-key"),
            ("admin", "another-provider", &equivalent, "first-key"),
            ("admin", "deepseek", &other, "first-key"),
            ("admin", "deepseek", &equivalent, "second-key"),
        ] {
            assert!(read(&first.discovery_id, admin, provider, url, key, now).is_none());
        }
        assert!(read(
            "unknown",
            "admin",
            "deepseek",
            &equivalent,
            "first-key",
            now
        )
        .is_none());
        for (ticket, key, id) in [
            (first, "first-key", "first"),
            (second, "second-key", "second"),
        ] {
            let catalog = read(
                &ticket.discovery_id,
                "admin",
                "deepseek",
                &equivalent,
                key,
                now + Duration::from_secs(599),
            )
            .unwrap();
            assert_eq!(catalog.models[0].id, id);
            assert_eq!(ticket.catalog.fetched_at, catalog.fetched_at);
            assert!(read(
                &ticket.discovery_id,
                "admin",
                "deepseek",
                &equivalent,
                key,
                now + Duration::from_secs(600)
            )
            .is_none());
        }
    }
}
