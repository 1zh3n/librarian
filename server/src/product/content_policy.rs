use std::sync::LazyLock;

use regex::Regex;

use super::security_levels::SecurityLevel;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Action {
    Allow,
    Redact,
    Deny,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Category {
    PrivateKey,
    CloudKey,
    BearerToken,
    DatabaseUrl,
    CredentialAssignment,
    HighEntropy,
    Email,
    Phone,
    IdentityNumber,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Finding {
    pub rule: &'static str,
    pub category: Category,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct Inspection {
    pub action: Action,
    pub findings: Vec<Finding>,
    pub redacted: String,
}

struct Rule {
    id: &'static str,
    category: Category,
    regex: &'static Regex,
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        Rule {
            id: "private_key",
            category: Category::PrivateKey,
            regex: &PRIVATE_KEY,
        },
        Rule {
            id: "cloud_key",
            category: Category::CloudKey,
            regex: &CLOUD_KEY,
        },
        Rule {
            id: "bearer_token",
            category: Category::BearerToken,
            regex: &BEARER_TOKEN,
        },
        Rule {
            id: "database_url",
            category: Category::DatabaseUrl,
            regex: &DATABASE_URL,
        },
        Rule {
            id: "credential_assignment",
            category: Category::CredentialAssignment,
            regex: &CREDENTIAL_ASSIGNMENT,
        },
        Rule {
            id: "high_entropy",
            category: Category::HighEntropy,
            regex: &HIGH_ENTROPY,
        },
        Rule {
            id: "email",
            category: Category::Email,
            regex: &EMAIL,
        },
        Rule {
            id: "phone",
            category: Category::Phone,
            regex: &PHONE,
        },
        Rule {
            id: "identity_number",
            category: Category::IdentityNumber,
            regex: &IDENTITY_NUMBER,
        },
    ]
});

static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\z)")
        .expect("valid private-key pattern")
});
static CLOUD_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").expect("valid cloud-key pattern")
});
static BEARER_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{20,}").expect("valid bearer pattern")
});
static DATABASE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^\s:/@]+:[^\s@]+@")
        .expect("valid database-url pattern")
});
static CREDENTIAL_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{12,})"#)
        .expect("valid credential-assignment pattern")
});
static HIGH_ENTROPY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Za-z0-9+/=_-]{40,}\b").expect("valid high-entropy pattern"));
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").expect("valid email pattern")
});
static PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\+86[\s-]?)?1[3-9]\d{9}\b|\+\d{8,15}\b").expect("valid phone pattern")
});
static IDENTITY_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b\d{17}[\dXx]\b").expect("valid identity pattern"));

fn looks_like_placeholder(value: &str) -> bool {
    value.starts_with('<')
        || value.starts_with('$')
        || value.starts_with("os.")
        || value.starts_with("process.")
        || value.starts_with("env.")
        || value.contains("${")
        || value.contains("...")
        || value.contains("***")
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "changeme" | "password" | "redacted" | "example"
        )
}

fn looks_like_high_entropy(value: &str) -> bool {
    let mut upper = false;
    let mut lower = false;
    let mut digit = false;
    for byte in value.bytes() {
        upper |= byte.is_ascii_uppercase();
        lower |= byte.is_ascii_lowercase();
        digit |= byte.is_ascii_digit();
    }
    upper && lower && digit
}

fn action_for(level: SecurityLevel, category: Category) -> Action {
    if matches!(
        category,
        Category::PrivateKey | Category::CloudKey | Category::BearerToken | Category::DatabaseUrl
    ) {
        return Action::Deny;
    }
    match level {
        SecurityLevel::Public => Action::Allow,
        SecurityLevel::Internal => Action::Redact,
        SecurityLevel::Confidential | SecurityLevel::Secret => Action::Deny,
    }
}

pub(crate) fn inspect(text: &str, level: SecurityLevel) -> Inspection {
    let mut findings = Vec::new();
    for rule in RULES.iter() {
        for captures in rule.regex.captures_iter(text) {
            let Some(matched) = captures.get(0) else {
                continue;
            };
            if rule.category == Category::CredentialAssignment {
                let Some(value) = captures.get(1) else {
                    continue;
                };
                if looks_like_placeholder(value.as_str()) {
                    continue;
                }
            }
            if rule.category == Category::HighEntropy && !looks_like_high_entropy(matched.as_str())
            {
                continue;
            }
            findings.push(Finding {
                rule: rule.id,
                category: rule.category,
                start: matched.start(),
                end: matched.end(),
            });
        }
    }
    findings.sort_unstable_by_key(|finding| (finding.start, finding.end));

    let mut action = Action::Allow;
    for finding in &findings {
        action = action.max(action_for(level, finding.category));
    }

    let redacted = if action == Action::Allow {
        text.to_owned()
    } else {
        let mut redacted = String::with_capacity(text.len());
        let mut cursor = 0;
        for finding in &findings {
            if finding.start < cursor {
                continue;
            }
            redacted.push_str(&text[cursor..finding.start]);
            redacted.push_str("[REDACTED:");
            redacted.push_str(finding.rule);
            redacted.push(']');
            cursor = finding.end;
        }
        redacted.push_str(&text[cursor..]);
        redacted
    };

    Inspection {
        action,
        findings,
        redacted,
    }
}

#[cfg(test)]
mod tests {
    use super::{inspect, Action, Category};
    use crate::product::security_levels::SecurityLevel;

    const PRIVATE_KEY: &str =
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    const CLOUD_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
    const BEARER: &str = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const DATABASE_URL: &str = "postgres://reader:supersecret@db.example.com/app";
    const HIGH_ENTROPY: &str = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5bC7d";
    const EMAIL: &str = "alice@example.com";
    const PHONE: &str = "+8613812345678";
    const IDENTITY: &str = "11010519491231002X";

    #[test]
    fn high_confidence_credentials_are_denied_at_every_level() {
        for level in [
            SecurityLevel::Public,
            SecurityLevel::Internal,
            SecurityLevel::Confidential,
            SecurityLevel::Secret,
        ] {
            for text in [PRIVATE_KEY, CLOUD_KEY, BEARER, DATABASE_URL] {
                let inspection = inspect(text, level);
                assert_eq!(inspection.action, Action::Deny, "{level:?} {text}");
                assert!(!inspection.findings.is_empty());
            }
        }
    }

    #[test]
    fn credential_assignments_are_redacted_or_denied_by_level() {
        let text = "api_key = sk_live_1234567890abcdef";
        let internal = inspect(text, SecurityLevel::Internal);
        assert_eq!(internal.action, Action::Redact);
        assert!(!internal.redacted.contains("sk_live_1234567890abcdef"));
        assert!(internal
            .redacted
            .contains("[REDACTED:credential_assignment]"));
        assert_eq!(
            inspect(text, SecurityLevel::Confidential).action,
            Action::Deny
        );
    }

    #[test]
    fn pii_is_redacted_internal_and_denied_when_confidential() {
        for text in [EMAIL, PHONE, IDENTITY] {
            let internal = inspect(text, SecurityLevel::Internal);
            assert_eq!(internal.action, Action::Redact, "{text}");
            assert!(internal.redacted.contains("[REDACTED:"));
            assert_eq!(
                inspect(text, SecurityLevel::Confidential).action,
                Action::Deny
            );
            assert_eq!(inspect(text, SecurityLevel::Public).action, Action::Allow);
        }
    }

    #[test]
    fn public_allows_non_secret_content() {
        let inspection = inspect("公开文章，包含 alice@example.com。", SecurityLevel::Public);
        assert_eq!(inspection.action, Action::Allow);
        assert_eq!(inspection.redacted, "公开文章，包含 alice@example.com。");
    }

    #[test]
    fn placeholders_and_environment_lookups_are_not_credentials() {
        for text in [
            "password = os.environ[\"PASSWORD\"]",
            "Authorization: Bearer <token>",
            "api_key = ${API_KEY}",
            "secret = changeme",
        ] {
            assert_eq!(
                inspect(text, SecurityLevel::Internal).action,
                Action::Allow,
                "{text}"
            );
        }
    }

    #[test]
    fn findings_never_carry_the_matched_text() {
        let inspection = inspect(PRIVATE_KEY, SecurityLevel::Internal);
        let debug = format!("{:?}", inspection.findings);
        assert!(!debug.contains("MIIEvQIBADANBg"));
        assert!(!debug.contains("PRIVATE KEY"));
        assert_eq!(inspection.findings[0].category, Category::PrivateKey);
    }

    #[test]
    fn redaction_keeps_surrounding_markdown() {
        let text = "前文\n\napi_key = sk_live_1234567890abcdef\n\n后文";
        let inspection = inspect(text, SecurityLevel::Internal);
        assert_eq!(inspection.action, Action::Redact);
        assert!(inspection.redacted.starts_with("前文\n\n"));
        assert!(inspection.redacted.ends_with("\n\n后文"));
        assert!(!inspection.redacted.contains("sk_live_1234567890abcdef"));
    }

    #[test]
    fn high_entropy_tokens_are_redacted_but_git_shas_are_not() {
        let token = inspect(HIGH_ENTROPY, SecurityLevel::Internal);
        assert_eq!(token.action, Action::Redact);
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(inspect(sha, SecurityLevel::Internal).action, Action::Allow);
    }

    #[test]
    fn normal_markdown_without_secrets_is_untouched() {
        let text = "# 标题\n\n普通正文，包含 `code` 和 [链接](https://example.com)。\n";
        let inspection = inspect(text, SecurityLevel::Secret);
        assert_eq!(inspection.action, Action::Allow);
        assert!(inspection.findings.is_empty());
        assert_eq!(inspection.redacted, text);
    }
}
