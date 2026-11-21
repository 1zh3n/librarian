//! Outbound fetch guard for client metadata documents: a DNS resolver that
//! only hands public addresses to the connector, so a hostname cannot point
//! the server at its own network (SSRF).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{self, HeaderMap, HeaderValue};
use reqwest::{redirect, StatusCode, Url};
use serde::Deserialize;

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || (a == 100 && (b & 0xc0) == 64)
        || (a == 192 && b == 0 && c == 0)
        || ip.is_documentation()
        || (a == 198 && (b & 0xfe) == 18)
        || ip.is_multicast()
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    // Only global unicast (2000::/3) is reachable on the public internet;
    // this also rules out loopback, unspecified, unique-local, link-local,
    // multicast and the NAT64 and IPv4-compatible forms.
    if s[0] & 0xe000 != 0x2000 {
        return false;
    }
    match s[0] {
        // Teredo, benchmarking and documentation
        0x2001 if s[1] == 0 || s[1] == 2 || s[1] == 0x0db8 => false,
        // 6to4 embeds an IPv4 address that decides where it goes
        0x2002 => is_public_v4(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        )),
        _ => true,
    }
}

/// Resolves with the system resolver, then falls back to a fixed public DoH
/// resolver when the system answer is empty or non-public (for example a
/// transparent proxy's fake IP). Every accepted address must still be public.
/// An IP-literal URL host never reaches a resolver, so callers must check
/// those themselves (`validate_cimd_url` does).
#[derive(Clone, Debug)]
pub struct PublicOnlyResolver {
    allow_loopback: bool,
    doh: Option<DohResolver>,
}

impl Default for PublicOnlyResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl PublicOnlyResolver {
    pub fn new() -> Self {
        Self {
            allow_loopback: false,
            doh: Some(DohResolver::new()),
        }
    }

    /// The historical behavior, used by tests and by callers that must not
    /// make an extra outbound request.
    pub fn without_doh() -> Self {
        Self {
            allow_loopback: false,
            doh: None,
        }
    }

    #[cfg(test)]
    pub fn allowing_loopback() -> Self {
        Self {
            allow_loopback: true,
            doh: None,
        }
    }

    #[cfg(test)]
    pub fn with_doh_for_tests(endpoint: Url) -> Self {
        Self {
            allow_loopback: false,
            doh: Some(DohResolver::for_tests(endpoint)),
        }
    }
}

const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";
const DOH_BOOTSTRAP_HOST: &str = "cloudflare-dns.com";
const DOH_BOOTSTRAP_IP: Ipv4Addr = Ipv4Addr::new(1, 1, 1, 1);
const DOH_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DOH_BODY: usize = 16 * 1024;

#[derive(Clone, Debug)]
struct DohResolver {
    endpoint: Url,
    client: reqwest::Client,
}

impl DohResolver {
    fn new() -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/dns-json"),
        );
        // Pin the endpoint's hostname to its documented address: the DoH
        // client must not consult the same resolver it is trying to repair.
        let client = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .timeout(DOH_TIMEOUT)
            .resolve(
                DOH_BOOTSTRAP_HOST,
                SocketAddr::new(DOH_BOOTSTRAP_IP.into(), 443),
            )
            .no_proxy()
            .https_only(true)
            .default_headers(headers)
            .build()
            .expect("public DoH HTTP client");
        Self {
            endpoint: Url::parse(DOH_ENDPOINT).expect("public DoH endpoint"),
            client,
        }
    }

    #[cfg(test)]
    fn for_tests(endpoint: Url) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/dns-json"),
        );
        let client = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .timeout(DOH_TIMEOUT)
            .no_proxy()
            .https_only(false)
            .default_headers(headers)
            .build()
            .expect("test DoH HTTP client");
        Self { endpoint, client }
    }

    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        let (a, aaaa) = tokio::join!(self.query(host, 1), self.query(host, 28));
        let mut ips = Vec::new();
        let mut errors = Vec::new();
        for result in [a, aaaa] {
            match result {
                Ok(mut answers) => ips.append(&mut answers),
                Err(error) => errors.push(error),
            }
        }
        if ips.is_empty() {
            return Err(if errors.is_empty() {
                "DoH returned no addresses".into()
            } else {
                errors.join("; ")
            });
        }
        if ips.iter().any(|ip| !is_public_ip(*ip)) {
            return Err("DoH returned a non-public address".into());
        }
        ips.sort();
        ips.dedup();
        Ok(ips)
    }

    async fn query(&self, host: &str, kind: u16) -> Result<Vec<IpAddr>, String> {
        let mut url = self.endpoint.clone();
        url.query_pairs_mut()
            .append_pair("name", host)
            .append_pair("type", &kind.to_string());
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("DoH request failed: {error}"))?;
        if response.status() != StatusCode::OK {
            return Err(format!("DoH returned HTTP {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOH_BODY as u64)
        {
            return Err("DoH response is too large".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("DoH body failed: {error}"))?
        {
            if body.len() + chunk.len() > MAX_DOH_BODY {
                return Err("DoH response is too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        parse_doh_ips(&body, kind)
    }
}

#[derive(Deserialize)]
struct DohResponse {
    #[serde(rename = "Status")]
    status: u16,
    #[serde(rename = "Answer", default)]
    answers: Vec<DohAnswer>,
}

#[derive(Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    kind: u16,
    data: String,
}

fn parse_doh_ips(body: &[u8], kind: u16) -> Result<Vec<IpAddr>, String> {
    let response: DohResponse = serde_json::from_slice(body)
        .map_err(|error| format!("DoH response is not JSON: {error}"))?;
    if response.status != 0 {
        return Ok(Vec::new());
    }
    let mut ips = Vec::new();
    for answer in response.answers {
        if answer.kind != kind {
            continue;
        }
        let ip = match kind {
            1 => answer.data.parse::<Ipv4Addr>().map(IpAddr::V4),
            28 => answer.data.parse::<Ipv6Addr>().map(IpAddr::V6),
            _ => continue,
        }
        .map_err(|_| "DoH returned an invalid address".to_string())?;
        ips.push(ip);
    }
    Ok(ips)
}

fn choose_addresses(
    host: &str,
    system: Result<Vec<SocketAddr>, String>,
    doh: Option<Vec<IpAddr>>,
    allow_loopback: bool,
) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    let allowed = |ip: IpAddr| is_public_ip(ip) || (allow_loopback && ip.is_loopback());
    if let Ok(addresses) = &system {
        if !addresses.is_empty() && addresses.iter().all(|address| allowed(address.ip())) {
            return Ok(addresses.clone());
        }
    }
    if let Some(ips) = doh {
        if !ips.is_empty() && ips.iter().all(|ip| allowed(*ip)) {
            return Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect());
        }
    }
    match system {
        Ok(addresses) => only_public(host, addresses, allow_loopback),
        Err(error) => Err(error.into()),
    }
}

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_loopback = self.allow_loopback;
        let doh = self.doh.clone();
        Box::pin(async move {
            let host = name.as_str().to_string();
            let system = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map(|addresses| addresses.collect::<Vec<_>>())
                .map_err(|error| error.to_string());
            let allowed = |ip: IpAddr| is_public_ip(ip) || (allow_loopback && ip.is_loopback());
            let system_is_public = system.as_ref().ok().is_some_and(|addresses| {
                !addresses.is_empty() && addresses.iter().all(|address| allowed(address.ip()))
            });
            let mut doh_ips = None;
            if !system_is_public {
                if let Some(doh) = &doh {
                    match doh.resolve(&host).await {
                        Ok(ips) => doh_ips = Some(ips),
                        Err(error) => {
                            tracing::warn!(%host, %error, "public DoH fallback failed");
                        }
                    }
                }
            }
            let used_doh = doh_ips.is_some();
            let result = choose_addresses(&host, system, doh_ips, allow_loopback);
            if used_doh && result.is_ok() {
                tracing::debug!(
                    %host,
                    "system DNS was not public; resolved via public DoH"
                );
            }
            result.map(|addresses| Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

/// Refuses the whole name when any address is non-public, rather than
/// dialing the public ones: a name that also points inward is not one the
/// server should be fetching from.
fn only_public(
    host: &str,
    addrs: Vec<SocketAddr>,
    allow_loopback: bool,
) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    if addrs.is_empty() {
        return Err(format!("{host} did not resolve").into());
    }
    let allowed = |ip: IpAddr| is_public_ip(ip) || (allow_loopback && ip.is_loopback());
    if !addrs.iter().all(|addr| allowed(addr.ip())) {
        return Err(format!("{host} resolves to a non-public address").into());
    }
    Ok(addrs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn is_public_ip_table() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "224.0.0.1",
            "192.0.2.1",
            "::",
            "ff02::1",
            "2001:db8::1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::1",
            "255.255.255.255",
            "198.18.0.1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "1.1.1.1",
            "2606:4700:4700::1111",
            "::ffff:1.1.1.1",
            "100.128.0.1",
            "2002:101:101::1",
        ] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn mixed_resolution_is_refused() {
        let addr = |s: &str| SocketAddr::new(s.parse().unwrap(), 0);
        let public = vec![addr("1.1.1.1"), addr("2606:4700:4700::1111")];
        assert_eq!(
            only_public("client.example", public.clone(), false).unwrap(),
            public
        );
        let mixed = vec![addr("1.1.1.1"), addr("10.0.0.5")];
        assert!(only_public("client.example", mixed, false).is_err());
        let mixed = vec![addr("127.0.0.1"), addr("1.1.1.1")];
        assert!(only_public("client.example", mixed.clone(), false).is_err());
        assert!(only_public("client.example", mixed, true).is_ok());
        let private_with_loopback = vec![addr("127.0.0.1"), addr("192.168.1.1")];
        assert!(only_public("client.example", private_with_loopback, true).is_err());
        assert!(only_public("client.example", vec![], true).is_err());
    }

    #[tokio::test]
    async fn resolver_refuses_loopback() {
        let name: Name = "localhost".parse().unwrap();
        assert!(PublicOnlyResolver::without_doh()
            .resolve(name)
            .await
            .is_err());
        let name: Name = "localhost".parse().unwrap();
        let addrs: Vec<_> = PublicOnlyResolver::allowing_loopback()
            .resolve(name)
            .await
            .unwrap()
            .collect();
        assert!(!addrs.is_empty());
    }

    fn addr(value: &str) -> SocketAddr {
        SocketAddr::new(value.parse().unwrap(), 0)
    }

    #[test]
    fn public_system_addresses_win_without_doh() {
        let result = choose_addresses(
            "client.example",
            Ok(vec![addr("1.1.1.1")]),
            Some(vec!["10.0.0.5".parse().unwrap()]),
            false,
        )
        .unwrap();
        assert_eq!(result, vec![addr("1.1.1.1")]);
    }

    #[test]
    fn fake_ip_system_answer_uses_public_doh() {
        let result = choose_addresses(
            "client.example",
            Ok(vec![addr("198.18.3.61")]),
            Some(vec!["104.18.10.66".parse().unwrap()]),
            false,
        )
        .unwrap();
        assert_eq!(result, vec![addr("104.18.10.66")]);
    }

    #[test]
    fn private_doh_answer_is_rejected() {
        let result = choose_addresses(
            "client.example",
            Ok(vec![addr("198.18.3.61")]),
            Some(vec!["10.0.0.5".parse().unwrap()]),
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn mixed_doh_answer_is_rejected() {
        let result = choose_addresses(
            "client.example",
            Ok(vec![addr("198.18.3.61")]),
            Some(vec![
                "104.18.10.66".parse().unwrap(),
                "10.0.0.5".parse().unwrap(),
            ]),
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn mixed_system_answer_uses_public_doh() {
        let result = choose_addresses(
            "client.example",
            Ok(vec![addr("1.1.1.1"), addr("10.0.0.5")]),
            Some(vec!["104.18.10.66".parse().unwrap()]),
            false,
        )
        .unwrap();
        assert_eq!(result, vec![addr("104.18.10.66")]);
    }

    #[test]
    fn empty_system_answer_uses_public_doh() {
        let result = choose_addresses(
            "client.example",
            Ok(vec![]),
            Some(vec!["104.18.10.66".parse().unwrap()]),
            false,
        )
        .unwrap();
        assert_eq!(result, vec![addr("104.18.10.66")]);
    }

    #[test]
    fn doh_parser_reads_addresses_and_skips_other_types() {
        let body = br#"{"Status":0,"Answer":[{"type":5,"data":"alias.example"},{"type":1,"data":"104.18.10.66"},{"type":28,"data":"2606:4700::6812:a42"}]}"#;
        assert_eq!(
            parse_doh_ips(body, 1).unwrap(),
            vec!["104.18.10.66".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(
            parse_doh_ips(body, 28).unwrap(),
            vec!["2606:4700::6812:a42".parse::<IpAddr>().unwrap()]
        );
    }

    #[test]
    fn doh_parser_handles_nxdomain_and_malformed_body() {
        assert!(parse_doh_ips(br#"{"Status":3,"Answer":[]}"#, 1)
            .unwrap()
            .is_empty());
        assert!(parse_doh_ips(b"not json", 1).is_err());
    }

    #[derive(Clone)]
    struct TestDoh {
        a: Vec<&'static str>,
        aaaa: Vec<&'static str>,
        hits: Arc<AtomicUsize>,
    }

    #[derive(Deserialize)]
    struct DohQuery {
        #[serde(rename = "type")]
        kind: String,
    }

    async fn serve_doh(a: Vec<&'static str>, aaaa: Vec<&'static str>) -> (Url, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let state = TestDoh {
            a,
            aaaa,
            hits: hits.clone(),
        };
        let app = axum::Router::new()
            .route(
                "/dns-query",
                axum::routing::get(
                    |axum::extract::Query(query): axum::extract::Query<DohQuery>,
                     axum::extract::State(state): axum::extract::State<TestDoh>| async move {
                        state.hits.fetch_add(1, Ordering::SeqCst);
                        let kind = query.kind.parse::<u16>().unwrap();
                        let answers: Vec<_> = if kind == 1 {
                            state
                                .a
                                .iter()
                                .map(|ip| serde_json::json!({"type": 1, "data": ip}))
                                .collect()
                        } else {
                            state
                                .aaaa
                                .iter()
                                .map(|ip| serde_json::json!({"type": 28, "data": ip}))
                                .collect()
                        };
                        axum::Json(serde_json::json!({"Status": 0, "Answer": answers}))
                    },
                ),
            )
            .with_state(state);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            Url::parse(&format!("http://127.0.0.1:{port}/dns-query")).unwrap(),
            hits,
        )
    }

    #[tokio::test]
    async fn resolver_uses_doh_when_system_loopback_is_not_allowed() {
        let (endpoint, hits) = serve_doh(vec!["104.18.10.66"], vec!["2606:4700:4700::1111"]).await;
        let resolver = PublicOnlyResolver::with_doh_for_tests(endpoint);
        let addrs: Vec<_> = resolver
            .resolve("localhost".parse().unwrap())
            .await
            .unwrap()
            .collect();
        assert!(addrs
            .iter()
            .any(|address| address.ip() == "104.18.10.66".parse::<IpAddr>().unwrap()));
        assert!(hits.load(Ordering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn resolver_rejects_private_doh_answers() {
        let (endpoint, _) = serve_doh(vec!["10.0.0.5"], vec![]).await;
        let resolver = PublicOnlyResolver::with_doh_for_tests(endpoint);
        assert!(resolver
            .resolve("localhost".parse().unwrap())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn resolver_skips_doh_for_public_system_answers() {
        let (endpoint, hits) = serve_doh(vec!["104.18.10.66"], vec![]).await;
        let resolver = PublicOnlyResolver::with_doh_for_tests(endpoint);
        let addrs: Vec<_> = resolver
            .resolve("1.1.1.1".parse().unwrap())
            .await
            .unwrap()
            .collect();
        assert_eq!(addrs, vec![addr("1.1.1.1")]);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}
