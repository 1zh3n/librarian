use serde::{Deserialize, Serialize};

pub const FILE_LIMIT: usize = 10 * 1024 * 1024;
pub const TEXT_LIMIT: usize = 512 * 1024;
pub const SEGMENT_LIMIT: usize = 8192;
pub const SEGMENT_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub segment_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_end: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Segment {
    #[serde(flatten)]
    pub location: Location,
    pub text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum ParseResult {
    Ready {
        segments: Vec<Segment>,
    },
    Failed {
        #[serde(rename = "errorCode")]
        error_code: String,
    },
}
