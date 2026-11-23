use serde::{Deserialize, Serialize};

/// Workspace data classification. The numeric order is also the downgrade
/// order: moving to a lower-ranked level requires explicit confirmation.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SecurityLevel {
    Public,
    #[default]
    Internal,
    Confidential,
    Secret,
}

impl SecurityLevel {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
            Self::Confidential => "confidential",
            Self::Secret => "secret",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "public" => Some(Self::Public),
            "internal" => Some(Self::Internal),
            "confidential" => Some(Self::Confidential),
            "secret" => Some(Self::Secret),
            _ => None,
        }
    }

    pub(crate) fn rank(self) -> u8 {
        match self {
            Self::Public => 0,
            Self::Internal => 1,
            Self::Confidential => 2,
            Self::Secret => 3,
        }
    }

    pub(crate) fn capabilities(self) -> SecurityCapabilities {
        match self {
            Self::Public => SecurityCapabilities {
                external_ai: true,
                external_mcp: true,
                anonymous_share: true,
                publication: true,
                offline: true,
                remote_backup: true,
            },
            Self::Internal => SecurityCapabilities {
                external_ai: true,
                external_mcp: true,
                anonymous_share: true,
                publication: false,
                offline: true,
                remote_backup: true,
            },
            Self::Confidential => SecurityCapabilities {
                external_ai: false,
                external_mcp: false,
                anonymous_share: false,
                publication: false,
                offline: false,
                remote_backup: true,
            },
            Self::Secret => SecurityCapabilities {
                external_ai: false,
                external_mcp: false,
                anonymous_share: false,
                publication: false,
                offline: false,
                remote_backup: false,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecurityCapabilities {
    pub external_ai: bool,
    pub external_mcp: bool,
    pub anonymous_share: bool,
    pub publication: bool,
    pub offline: bool,
    pub remote_backup: bool,
}

#[cfg(test)]
mod tests {
    use super::SecurityLevel;

    #[test]
    fn secret_disables_every_external_capability() {
        let capabilities = SecurityLevel::Secret.capabilities();
        assert!(!capabilities.external_ai);
        assert!(!capabilities.external_mcp);
        assert!(!capabilities.anonymous_share);
        assert!(!capabilities.publication);
        assert!(!capabilities.offline);
        assert!(!capabilities.remote_backup);
    }

    #[test]
    fn only_public_can_publish() {
        assert!(SecurityLevel::Public.capabilities().publication);
        for level in [
            SecurityLevel::Internal,
            SecurityLevel::Confidential,
            SecurityLevel::Secret,
        ] {
            assert!(!level.capabilities().publication, "{level:?}");
        }
    }

    #[test]
    fn database_values_round_trip() {
        for level in [
            SecurityLevel::Public,
            SecurityLevel::Internal,
            SecurityLevel::Confidential,
            SecurityLevel::Secret,
        ] {
            assert_eq!(SecurityLevel::from_db(level.as_str()), Some(level));
        }
        assert_eq!(SecurityLevel::from_db("top-secret"), None);
    }
}
