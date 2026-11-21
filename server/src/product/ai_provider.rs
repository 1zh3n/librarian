use std::{
    collections::HashSet,
    fs, io,
    net::{IpAddr, SocketAddr},
    path::Path,
    time::Duration,
};

use axum::http::{uri::Authority, StatusCode};
use reqwest::{redirect, Client, Url};
use serde::{Deserialize, Serialize};

use super::contract::ApiError;
use crate::auth::mcp::net::is_public_ip;

const CATALOG_LIMIT: usize = 256 * 1024;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoveredModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(alias = "input_modalities", skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(alias = "output_modalities", skip_serializing_if = "Option::is_none")]
    pub output_modalities: Option<Vec<String>>,
    #[serde(alias = "context_window", skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(alias = "max_output_tokens", skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Effort {
    #[serde(alias = "supported_levels")]
    pub supported_levels: Vec<String>,
    #[serde(alias = "default_level", skip_serializing_if = "Option::is_none")]
    pub default_level: Option<String>,
}

fn rejected() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "provider_address_rejected",
        "Use an allowed provider address",
    )
}

fn upstream(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, code, message)
}

fn unavailable() -> ApiError {
    upstream(
        "provider_unavailable",
        "Could not connect to the model catalog",
    )
}

fn timeout() -> ApiError {
    ApiError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "provider_timeout",
        "The provider request timed out",
    )
}

fn invalid_catalog() -> ApiError {
    upstream(
        "provider_invalid_catalog",
        "The provider returned an invalid model catalog",
    )
}

fn too_large() -> ApiError {
    upstream(
        "provider_response_too_large",
        "The model catalog exceeds the response limit",
    )
}

pub(super) fn normalize(raw: &str) -> Result<Url, ApiError> {
    // Reject ambiguous authority syntax before the WHATWG parser can repair it.
    let (_, rest) = raw.split_once("://").ok_or_else(rejected)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty()
        || authority.contains('@')
        || raw.contains('\\')
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(rejected());
    }
    let url = Url::parse(raw).map_err(|_| rejected())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err(rejected());
    }
    Url::parse(url.as_str().trim_end_matches('/')).map_err(|_| rejected())
}

pub(super) struct AddressPolicy {
    private_endpoint: Option<(String, u16)>,
    test_loopback: Option<SocketAddr>,
}

fn setting(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Ok(meta) if meta.is_file() && meta.len() <= 1024 => fs::read_to_string(path)
            .map(|s| Some(s.trim().to_owned()))
            .map_err(|_| "Cannot read AI address policy".into()),
        _ => Err("Invalid AI address policy file".into()),
    }
}

impl AddressPolicy {
    pub(super) fn load(metadata: &super::db::Metadata) -> Result<Self, String> {
        let private_endpoint = setting(&metadata.product_file("ai-private-endpoint"))?
            .map(|s| {
                let authority = s.parse::<Authority>().ok().filter(|_| !s.contains('@'));
                let pair =
                    authority.and_then(|a| Some((a.host().to_ascii_lowercase(), a.port_u16()?)));
                pair.filter(|(h, p)| !h.is_empty() && *p > 0)
                    .ok_or("Expected host:port in ai-private-endpoint")
            })
            .transpose()?;
        let test_loopback = if cfg!(debug_assertions) {
            setting(&metadata.product_file("ai-test-loopback"))?
                .map(|s| {
                    s.parse::<SocketAddr>()
                        .ok()
                        .filter(|a| a.port() > 0 && a.ip().is_loopback())
                        .ok_or("Expected a loopback IP:port in ai-test-loopback")
                })
                .transpose()?
        } else {
            None
        };
        Ok(Self {
            private_endpoint,
            test_loopback,
        })
    }

    fn matches_fixture(&self, host: &str, port: u16) -> bool {
        literal_ip(host)
            .map(|ip| SocketAddr::new(ip, port))
            .is_some_and(|addr| self.test_loopback == Some(addr))
    }

    fn check(&self, url: &Url, addresses: &[SocketAddr]) -> Result<(), ApiError> {
        let host = url.host_str().ok_or_else(rejected)?;
        let port = url.port_or_known_default().ok_or_else(rejected)?;
        let fixture = self.matches_fixture(host, port);
        let private = self
            .private_endpoint
            .as_ref()
            .is_some_and(|(h, p)| h == host && *p == port);
        if url.scheme() != "https" && !fixture {
            return Err(rejected());
        }
        if addresses.is_empty()
            || !addresses.iter().all(|addr| {
                if addr.port() != port {
                    return false;
                }
                let ip = addr.ip().to_canonical();
                let lan = match ip {
                    IpAddr::V4(ip) => ip.is_private(),
                    IpAddr::V6(ip) => ip.is_unique_local(),
                };
                public_destination(ip)
                    || (private && lan)
                    || (fixture && self.test_loopback == Some(*addr))
            })
        {
            return Err(rejected());
        }
        Ok(())
    }

    pub(super) async fn resolve(&self, url: Url) -> Result<PinnedEndpoint, ApiError> {
        let host = url.host_str().ok_or_else(rejected)?;
        let port = url.port_or_known_default().ok_or_else(rejected)?;
        if url.scheme() != "https" && !self.matches_fixture(host, port) {
            return Err(rejected());
        }
        let addresses = match literal_ip(host) {
            Some(ip) => vec![SocketAddr::new(ip, port)],
            None => tokio::time::timeout(DISCOVERY_TIMEOUT, tokio::net::lookup_host((host, port)))
                .await
                .map_err(|_| timeout())?
                .map_err(|_| unavailable())?
                .collect(),
        };
        self.check(&url, &addresses)?;
        Ok(PinnedEndpoint {
            base_url: url,
            addresses,
        })
    }
}

pub(super) struct PinnedEndpoint {
    pub base_url: Url,
    pub addresses: Vec<SocketAddr>,
}

impl PinnedEndpoint {
    fn client(&self) -> Result<Client, ApiError> {
        let host = self.base_url.host_str().ok_or_else(rejected)?;
        // A fresh direct connection uses exactly the checked answer set. The original
        // URL supplies the TLS server name, certificate verification and Host header.
        Client::builder()
            .no_proxy()
            .redirect(redirect::Policy::none())
            .resolve_to_addrs(host, &self.addresses)
            .build()
            .map_err(|_| unavailable())
    }
}

fn literal_ip(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

fn public_destination(ip: IpAddr) -> bool {
    if !is_public_ip(ip) {
        return false;
    }
    match ip {
        // Deprecated relay anycast and IPv6 transition/special-purpose ranges.
        IpAddr::V4(ip) => !ip.octets().starts_with(&[192, 88, 99]),
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            !(a == 0x2002 || (a == 0x2001 && b < 0x0200) || (a == 0x3fff && b < 0x1000))
        }
    }
}

pub(super) async fn models(
    policy: &AddressPolicy,
    base: &Url,
    key: &str,
) -> Result<Vec<DiscoveredModel>, ApiError> {
    tokio::time::timeout(DISCOVERY_TIMEOUT, fetch(policy, base, key))
        .await
        .map_err(|_| timeout())?
}

async fn fetch(
    policy: &AddressPolicy,
    base: &Url,
    key: &str,
) -> Result<Vec<DiscoveredModel>, ApiError> {
    let pinned = policy.resolve(base.clone()).await?;
    let client = pinned.client()?;
    let mut endpoint = pinned.base_url;
    endpoint
        .path_segments_mut()
        .map_err(|_| rejected())?
        .pop_if_empty()
        .push("models");
    let mut response = client
        .get(endpoint)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| unavailable())?;
    match response.status() {
        s if s.is_success() => {}
        s if s.is_redirection() => {
            return Err(upstream(
                "provider_redirect",
                "Enter the final provider address directly",
            ))
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(upstream(
                "provider_auth_failed",
                "The provider rejected the credential",
            ))
        }
        StatusCode::TOO_MANY_REQUESTS => {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limited",
                "The provider rate limit was reached",
            ))
        }
        _ => return Err(unavailable()),
    }
    if response
        .content_length()
        .is_some_and(|n| n > CATALOG_LIMIT as u64)
    {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if chunk.len() > CATALOG_LIMIT - bytes.len() {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Catalog {
        data: Vec<DiscoveredModel>,
    }
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| invalid_catalog())?;
    if catalog.data.is_empty() {
        return Err(upstream(
            "provider_empty_catalog",
            "The provider returned no models",
        ));
    }
    let mut ids = HashSet::new();
    for model in &catalog.data {
        if !ids.insert(&model.id) || !model.safe_fields(key) {
            return Err(invalid_catalog());
        }
    }
    Ok(catalog.data)
}

impl DiscoveredModel {
    fn safe_fields(&self, key: &str) -> bool {
        // A provider can echo a bearer token even in an otherwise valid display field.
        let safe = |s: &String| {
            !s.trim().is_empty() && !s.chars().any(char::is_control) && !s.contains(key)
        };
        safe(&self.id)
            && self.name.iter().all(safe)
            && self.input_modalities.iter().flatten().all(safe)
            && self.output_modalities.iter().flatten().all(safe)
            && self.effort.as_ref().is_none_or(|e| {
                e.supported_levels.iter().all(safe)
                    && e.default_level
                        .as_ref()
                        .is_none_or(|d| e.supported_levels.contains(d))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connector_uses_the_approved_ip_and_original_host() {
        use axum::{
            http::{header, HeaderMap},
            routing::get,
            Router,
        };
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        let upstream =
            Router::new().route(
                "/models",
                get(|headers: HeaderMap| async move {
                    headers[header::HOST].to_str().unwrap().to_owned()
                }),
            );
        tokio::spawn(async move { axum::serve(socket, upstream).await.unwrap() });
        let host = format!("pin-fixture.invalid:{}", addr.port());
        let pinned = PinnedEndpoint {
            base_url: normalize(&format!("http://{host}")).unwrap(),
            addresses: vec![addr],
        };
        let response = pinned
            .client()
            .unwrap()
            .get(pinned.base_url.join("models").unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), host);
    }

    #[test]
    fn validates_every_resolved_address_and_the_exact_private_authority() {
        let policy = AddressPolicy {
            private_endpoint: Some(("models.internal".into(), 8443)),
            test_loopback: None,
        };
        let allowed = |url, ips: &[&str]| {
            let endpoint = normalize(url).unwrap();
            let addrs: Vec<_> = ips
                .iter()
                .map(|s| {
                    SocketAddr::new(
                        s.parse().unwrap(),
                        endpoint.port_or_known_default().unwrap(),
                    )
                })
                .collect();
            policy.check(&endpoint, &addrs).is_ok()
        };
        assert!(allowed(
            "https://example.org",
            &["1.1.1.1", "2606:4700:4700::1111"]
        ));
        assert!(!allowed("https://example.org", &[]));
        assert!(!allowed("https://example.org", &["1.1.1.1", "192.168.0.9"]));
        assert!(allowed(
            "https://models.internal:8443",
            &["192.168.0.9", "fd00::1"]
        ));
        assert!(!allowed("https://models.internal", &["192.168.0.9"]));
        assert!(!allowed("https://other.internal:8443", &["192.168.0.9"]));
        assert!(!allowed(
            "https://models.internal:8443",
            &["169.254.169.254"]
        ));
    }
}
