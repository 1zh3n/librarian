use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use super::{
    auth::Account,
    contract::ApiError,
    documents::{body, run, DocumentService},
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Font {
    Serif,
    Sans,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Layout {
    Reading,
    Writing,
    Research,
    Review,
    Custom,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DevicePreferences {
    theme: Theme,
    font: Font,
    layout: Layout,
    font_size: u8,
    line_height: f32,
    measure: u8,
    navigation: Option<bool>,
    sidebar_width: u16,
    tools_width: u16,
    eink: bool,
    reduce_motion: bool,
    focus_key: String,
}

impl Default for DevicePreferences {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            font: Font::Serif,
            layout: Layout::Custom,
            font_size: 18,
            line_height: 1.85,
            measure: 42,
            navigation: None,
            sidebar_width: 236,
            tools_width: 256,
            eink: false,
            reduce_motion: false,
            focus_key: "f".into(),
        }
    }
}

impl DevicePreferences {
    fn validate(&self) -> Result<(), ApiError> {
        if !(16..=28).contains(&self.font_size)
            || !(1.4..=2.4).contains(&self.line_height)
            || !(28..=56).contains(&self.measure)
            || !(176..=360).contains(&self.sidebar_width)
            || !(200..=480).contains(&self.tools_width)
        {
            return Err(ApiError::invalid(
                "Reading dimensions are outside the supported range",
            ));
        }
        if self.focus_key.len() > 1 || !self.focus_key.bytes().all(|byte| byte.is_ascii_lowercase())
        {
            return Err(ApiError::invalid(
                "Focus key must be a lowercase letter or empty",
            ));
        }
        Ok(())
    }
}

fn validate_device(device: &str) -> Result<(), ApiError> {
    if !(8..=64).contains(&device.len())
        || !device
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ApiError::invalid("Invalid device ID"));
    }
    Ok(())
}

pub(super) async fn get_preferences(
    State(service): State<Arc<DocumentService>>,
    Path(device): Path<String>,
    headers: HeaderMap,
) -> Result<Json<DevicePreferences>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, false)?;
    validate_device(&device)?;
    run(move || {
        let settings = service
            .metadata
            .device_preferences(account.username(), &device)?;
        let settings = settings
            .map(|encoded| serde_json::from_str(&encoded))
            .transpose()
            .map_err(ApiError::internal)?
            .unwrap_or_default();
        Ok(Json(settings))
    })
    .await
}

pub(super) async fn save_preferences(
    State(service): State<Arc<DocumentService>>,
    Path(device): Path<String>,
    headers: HeaderMap,
    request: Result<Json<DevicePreferences>, JsonRejection>,
) -> Result<Json<DevicePreferences>, ApiError> {
    let account = Account::authenticate(&service.spaces, &headers, true)?;
    validate_device(&device)?;
    let settings = body(request)?;
    settings.validate()?;
    run(move || {
        let encoded = serde_json::to_string(&settings).map_err(ApiError::internal)?;
        service
            .metadata
            .set_device_preferences(account.username(), &device, &encoded)?;
        Ok(Json(settings))
    })
    .await
}
