use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use sha1::Sha1;
use silverbullet_server_common::revision::sha256_hex;

type HmacSha1 = Hmac<Sha1>;

pub const PERIOD_SECS: u64 = 30;
pub const DIGITS: u32 = 6;
const RECOVERY_BYTES: usize = 10;

pub fn generate_secret() -> String {
    let mut bytes = [0u8; 20];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    BASE32_NOPAD.encode(&bytes)
}

pub fn otpauth_uri(issuer: &str, username: &str, secret: &str) -> String {
    let label = format!(
        "{}:{}",
        utf8_percent_encode(issuer, NON_ALPHANUMERIC),
        utf8_percent_encode(username, NON_ALPHANUMERIC)
    );
    let issuer = utf8_percent_encode(issuer, NON_ALPHANUMERIC);
    format!(
        "otpauth://totp/{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={DIGITS}&period={PERIOD_SECS}"
    )
}

pub fn verify(secret: &str, code: &str, now: u64) -> Option<u64> {
    let normalized: String = secret
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect();
    let key = BASE32_NOPAD.decode(normalized.as_bytes()).ok()?;
    if key.len() < 10 {
        return None;
    }
    let code = code.trim();
    if code.len() != DIGITS as usize || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let counter = now / PERIOD_SECS;
    for delta in [-1i64, 0, 1] {
        let step = counter as i64 + delta;
        if step < 0 {
            continue;
        }
        let expected = hotp(&key, step as u64);
        if constant_time_eq(expected.as_bytes(), code.as_bytes()) {
            return Some(step as u64);
        }
    }
    None
}

/// The code for the current or a given step. Used by tests and enrolment
/// previews; production verification only consumes codes.
pub fn current_code(secret: &str, now: u64) -> Option<String> {
    let normalized: String = secret
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .flat_map(char::to_uppercase)
        .collect();
    let key = BASE32_NOPAD.decode(normalized.as_bytes()).ok()?;
    Some(hotp(&key, now / PERIOD_SECS))
}

pub fn generate_recovery_codes(count: usize) -> (Vec<String>, Vec<String>) {
    let mut plain = Vec::with_capacity(count);
    let mut hashed = Vec::with_capacity(count);
    for _ in 0..count {
        let mut bytes = [0u8; RECOVERY_BYTES];
        getrandom::fill(&mut bytes).expect("operating system randomness");
        let code = BASE32_NOPAD.encode(&bytes);
        let grouped = format!("{}-{}", &code[..8], &code[8..]);
        plain.push(grouped.clone());
        hashed.push(sha256_hex(grouped.as_bytes()));
    }
    (plain, hashed)
}

pub fn recovery_hash(code: &str) -> String {
    let normalized: String = code
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect();
    sha256_hex(normalized.as_bytes())
}

fn hotp(secret: &[u8], counter: u64) -> String {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let value = u32::from_be_bytes([
        digest[offset],
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]) & 0x7fff_ffff;
    format!("{:06}", value % 1_000_000)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::{generate_recovery_codes, generate_secret, otpauth_uri, recovery_hash, verify};

    #[test]
    fn matches_the_rfc_6238_sha1_vector() {
        // RFC 6238 test secret "12345678901234567890" in base32.
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(verify(secret, "287082", 59), Some(1));
        assert_eq!(verify(secret, "081804", 1111111109), Some(37037036));
        assert!(verify(secret, "000000", 59).is_none());
    }

    #[test]
    fn accepts_one_step_of_clock_skew_and_rejects_replays_by_step() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(verify(secret, "287082", 60), Some(1));
        assert_eq!(verify(secret, "287082", 30), Some(1));
        assert!(verify(secret, "287082", 30 * 100).is_none());
    }

    #[test]
    fn generated_secrets_are_base32_and_recovery_codes_are_grouped() {
        let secret = generate_secret();
        assert_eq!(secret.len(), 32);
        assert!(secret
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()));
        let (plain, hashed) = generate_recovery_codes(10);
        assert_eq!(plain.len(), 10);
        assert_eq!(hashed.len(), 10);
        assert!(plain[0].contains('-'));
        assert_eq!(hashed[0], recovery_hash(&plain[0]));
        assert_ne!(plain[0], plain[1]);
    }

    #[test]
    fn otpauth_uri_keeps_the_issuer_and_secret() {
        let uri = otpauth_uri("Librarian", "alice", "AAAA");
        assert!(uri.starts_with("otpauth://totp/Librarian:alice?"));
        assert!(uri.contains("secret=AAAA"));
        assert!(uri.contains("issuer=Librarian"));
    }
}
