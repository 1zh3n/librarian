use std::{
    collections::HashMap,
    hash::Hash,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use silverbullet_server_common::revision::sha256_hex;

const MAX_TRACKED_KEYS: usize = 4096;
const SOURCE_MULTIPLIER: u32 = 5;
const MAX_CONCURRENT_PASSWORD_CHECKS: usize = 4;
const MAX_WAITING_LOGINS: usize = 24;
const LOGIN_WAIT: Duration = Duration::from_secs(2);
pub(super) const PASSWORD_REQUIREMENTS: &str =
    "The password must contain at least 15 characters and at most 4096 bytes";

pub(super) fn valid_password(value: &str) -> bool {
    value.len() <= 4096 && value.chars().count() >= 15
}

pub struct PasswordLimits {
    attempts: Mutex<LoginAttempts>,
    workers: Arc<tokio::sync::Semaphore>,
    waiting: tokio::sync::Semaphore,
}

impl PasswordLimits {
    pub(super) fn new(seconds: u64, limit: u32) -> Arc<Self> {
        Arc::new(Self {
            attempts: Mutex::new(LoginAttempts::new(
                Instant::now(),
                Duration::from_secs(seconds),
                limit,
            )),
            workers: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PASSWORD_CHECKS)),
            waiting: tokio::sync::Semaphore::new(MAX_WAITING_LOGINS),
        })
    }

    pub fn reserve(
        self: &Arc<Self>,
        username: &str,
        source: Option<IpAddr>,
    ) -> Option<PasswordCheck> {
        let worker = self.workers.clone().try_acquire_owned().ok()?;
        self.charge(username, source, worker)
    }

    pub async fn reserve_login(
        self: &Arc<Self>,
        username: &str,
        source: Option<IpAddr>,
    ) -> Option<PasswordCheck> {
        let waiting = self.waiting.try_acquire().ok()?;
        let worker = tokio::time::timeout(LOGIN_WAIT, self.workers.clone().acquire_owned())
            .await
            .ok()?
            .ok()?;
        drop(waiting);
        self.charge(username, source, worker)
    }

    fn charge(
        self: &Arc<Self>,
        username: &str,
        source: Option<IpAddr>,
        worker: tokio::sync::OwnedSemaphorePermit,
    ) -> Option<PasswordCheck> {
        let mut attempts = self.attempts.lock().ok()?;
        let admitted = Instant::now();
        if !attempts.admit(admitted, username, source) {
            return None;
        }
        Some(PasswordCheck {
            limits: self.clone(),
            admitted,
            username: username.to_owned(),
            source,
            _worker: worker,
        })
    }
}

pub struct PasswordCheck {
    limits: Arc<PasswordLimits>,
    admitted: Instant,
    username: String,
    source: Option<IpAddr>,
    _worker: tokio::sync::OwnedSemaphorePermit,
}

impl PasswordCheck {
    pub fn succeeded(self) {
        if let Ok(mut attempts) = self.limits.attempts.lock() {
            attempts.succeeded(self.admitted, &self.username, self.source);
        }
    }
}

struct LoginAttempts {
    start: Instant,
    window: Duration,
    limit: u32,
    accounts: HashMap<String, u32>,
    sources: HashMap<IpAddr, u32>,
}

impl LoginAttempts {
    pub(super) fn new(start: Instant, window: Duration, limit: u32) -> Self {
        Self {
            start,
            window,
            limit,
            accounts: HashMap::new(),
            sources: HashMap::new(),
        }
    }

    pub(super) fn admit(&mut self, now: Instant, username: &str, source: Option<IpAddr>) -> bool {
        if self.window.is_zero() || self.limit == 0 {
            return true;
        }
        if now.duration_since(self.start) >= self.window {
            self.start = now;
            self.accounts.clear();
            self.sources.clear();
        }
        let key = sha256_hex(username.as_bytes());
        let source_limit = self.limit.saturating_mul(SOURCE_MULTIPLIER);
        if self
            .accounts
            .get(&key)
            .is_some_and(|count| *count >= self.limit)
            || source.is_some_and(|ip| {
                self.sources
                    .get(&ip)
                    .is_some_and(|count| *count >= source_limit)
            })
        {
            return false;
        }
        record(&mut self.accounts, key);
        if let Some(ip) = source {
            record(&mut self.sources, ip);
        }
        true
    }

    pub(super) fn succeeded(&mut self, admitted: Instant, username: &str, source: Option<IpAddr>) {
        if admitted < self.start {
            return;
        }
        let key = sha256_hex(username.as_bytes());
        if let Some(count) = self.accounts.get_mut(&key) {
            *count = count.saturating_sub(1);
        }
        if let Some(count) = source.and_then(|ip| self.sources.get_mut(&ip)) {
            *count = count.saturating_sub(1);
        }
    }
}

fn record<K: Eq + Hash>(counters: &mut HashMap<K, u32>, key: K) {
    if let Some(count) = counters.get_mut(&key) {
        *count = count.saturating_add(1);
    } else if counters.len() < MAX_TRACKED_KEYS {
        counters.insert(key, 1);
    }
}

pub fn client_address(
    peer: Option<IpAddr>,
    trust_loopback_proxy: bool,
    forwarded: Option<&str>,
) -> Option<IpAddr> {
    let peer = peer?.to_canonical();
    if peer.is_loopback() {
        if trust_loopback_proxy {
            return forwarded?
                .parse::<IpAddr>()
                .ok()
                .map(|ip| ip.to_canonical());
        }
        return None;
    }
    Some(peer)
}

#[cfg(test)]
mod tests {
    use std::{
        net::IpAddr,
        time::{Duration, Instant},
    };

    use super::{client_address, LoginAttempts, PasswordLimits};

    #[test]
    fn password_processors_share_a_bounded_number_of_workers() {
        let limits = PasswordLimits::new(60, 10);
        let work: Vec<_> = (0..4)
            .map(|_| limits.reserve("reader", None).unwrap())
            .collect();
        assert!(limits.reserve("other", None).is_none());
        drop(work);
        assert!(limits.reserve("other", None).is_some());
    }

    #[tokio::test]
    async fn a_short_login_burst_can_wait_for_an_available_worker() {
        let limits = PasswordLimits::new(60, 10);
        let mut work: Vec<_> = (0..4)
            .map(|_| limits.reserve("reader", None).unwrap())
            .collect();
        let spare = limits.clone();
        let next = tokio::spawn(async move { spare.reserve_login("another", None).await });
        tokio::task::yield_now().await;
        assert!(!next.is_finished());
        drop(work.pop());
        assert!(next.await.unwrap().is_some());
    }

    #[test]
    fn account_attempts_preserve_access_for_other_accounts() {
        let instant = Instant::now();
        let ip = Some("192.0.2.1".parse().unwrap());
        let mut attempts = LoginAttempts::new(instant, Duration::from_secs(1), 2);
        assert!(attempts.admit(instant, "first", ip));
        assert!(attempts.admit(instant, "first", ip));
        assert!(!attempts.admit(instant, "first", ip));
        assert!(attempts.admit(instant, "second", ip));
        assert!(attempts.admit(instant + Duration::from_secs(1), "first", ip));
    }

    #[test]
    fn source_limit_is_independent_of_other_sources() {
        let instant = Instant::now();
        let first = Some("192.0.2.1".parse().unwrap());
        let second = Some("192.0.2.2".parse().unwrap());
        let mut attempts = LoginAttempts::new(instant, Duration::from_secs(1), 1);
        for index in 0..5 {
            assert!(attempts.admit(instant, &format!("account-{index}"), first));
        }
        assert!(!attempts.admit(instant, "next", first));
        assert!(attempts.admit(instant, "next", second));
    }

    #[test]
    fn successful_login_releases_its_own_reservation() {
        let instant = Instant::now();
        let ip = Some("192.0.2.1".parse().unwrap());
        let window = Duration::from_secs(1);
        let mut attempts = LoginAttempts::new(instant, window, 1);
        for _ in 0..10 {
            assert!(attempts.admit(instant, "account", ip));
            attempts.succeeded(instant, "account", ip);
        }
        assert!(attempts.admit(instant, "account", ip));
        assert!(attempts.admit(instant + window, "account", ip));
        attempts.succeeded(instant, "account", ip);
        assert!(!attempts.admit(instant + window, "account", ip));
    }

    #[test]
    fn trusted_proxy_source_requires_explicit_loopback_peer() {
        let external: IpAddr = "192.0.2.1".parse().unwrap();
        let forwarded: IpAddr = "192.0.2.2".parse().unwrap();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(
            client_address(Some(external), true, Some("192.0.2.2")),
            Some(external)
        );
        assert_eq!(
            client_address(Some(loopback), true, Some("192.0.2.2")),
            Some(forwarded)
        );
        assert_eq!(
            client_address(Some(loopback), false, Some("192.0.2.2")),
            None
        );
        assert_eq!(client_address(None, true, Some("192.0.2.2")), None);
    }
}
