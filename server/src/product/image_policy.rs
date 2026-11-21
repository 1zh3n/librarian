use axum::http::StatusCode;
use serde::Deserialize;
use unicode_normalization_alignments::UnicodeNormalization;

use super::{
    contract::ApiError,
    mutations::{self, MAX_ASSET_BYTES},
};

pub(super) const MAX_IMAGE_SIDE: usize = 12_000;
pub(super) const MAX_IMAGE_PIXELS: u64 = 40_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ImageKind {
    Png,
    Jpeg,
    Webp,
    Gif,
    Avif,
}

impl ImageKind {
    pub(super) fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
            Self::Avif => "image/avif",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ConflictPolicy {
    #[default]
    Rename,
    Reject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ImageInfo {
    pub kind: ImageKind,
    pub width: usize,
    pub height: usize,
}

pub(super) fn is_image_extension(path: &str) -> bool {
    extension_kind(path).is_some()
}

pub(super) fn inspect(file_name: &str, bytes: &[u8]) -> Result<ImageInfo, ApiError> {
    if bytes.is_empty() {
        return Err(invalid_image());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(asset_too_large());
    }
    let Some(extension_kind) = extension_kind(file_name) else {
        return Err(unsupported_image_type());
    };
    let Some(content_kind) = detect_kind(bytes) else {
        return Err(invalid_image());
    };
    if extension_kind != content_kind {
        return Err(invalid_image());
    }
    let size = imagesize::blob_size(bytes).map_err(|_| invalid_image())?;
    if size.width == 0
        || size.height == 0
        || size.width > MAX_IMAGE_SIDE
        || size.height > MAX_IMAGE_SIDE
        || (size.width as u64).saturating_mul(size.height as u64) > MAX_IMAGE_PIXELS
    {
        return Err(image_too_large());
    }
    Ok(ImageInfo {
        kind: content_kind,
        width: size.width,
        height: size.height,
    })
}

pub(super) fn detect_kind(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(ImageKind::Png);
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(ImageKind::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    if is_avif(bytes) {
        return Some(ImageKind::Avif);
    }
    None
}

fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let box_size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = box_size.max(16).min(bytes.len());
    bytes[8..end]
        .as_chunks::<4>()
        .0
        .iter()
        .any(|brand| brand == b"avif" || brand == b"avis")
}

pub(super) fn extension_kind(file_name: &str) -> Option<ImageKind> {
    let extension = file_name.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some(ImageKind::Png),
        "jpg" | "jpeg" => Some(ImageKind::Jpeg),
        "webp" => Some(ImageKind::Webp),
        "gif" => Some(ImageKind::Gif),
        "avif" => Some(ImageKind::Avif),
        _ => None,
    }
}

pub(super) fn validate_file_name(file_name: &str) -> Result<String, ApiError> {
    if file_name.is_empty() || file_name.len() > 255 {
        return Err(invalid_path());
    }
    if file_name == "." || file_name == ".." {
        return Err(invalid_path());
    }
    if file_name
        .chars()
        .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err(invalid_path());
    }
    if file_name.ends_with(' ') || file_name.ends_with('.') {
        return Err(invalid_path());
    }
    let normalized: String = file_name.nfc().map(|(character, _)| character).collect();
    if normalized != file_name {
        return Err(invalid_path());
    }
    let stem = file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _)| stem)
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err(invalid_path());
    }
    if extension_kind(file_name).is_none() {
        return Err(unsupported_image_type());
    }
    Ok(normalized)
}

pub(super) fn validate_directory(directory: &str) -> Result<String, ApiError> {
    let directory = directory.trim_end_matches('/');
    let normalized: String = directory.nfc().map(|(character, _)| character).collect();
    if normalized != directory {
        return Err(invalid_path());
    }
    if directory.is_empty() {
        return Ok(directory.to_owned());
    }
    if !mutations::valid_file_path(directory) || directory.starts_with('/') {
        return Err(invalid_path());
    }
    Ok(directory.to_owned())
}

pub(super) fn asset_too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "asset_too_large",
        "Image exceeds the asset size limit",
    )
}

pub(super) fn unsupported_image_type() -> ApiError {
    ApiError::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_image_type",
        "Only PNG, JPEG, WebP, GIF and AVIF images are supported",
    )
}

pub(super) fn invalid_image() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_image",
        "Image content is empty, truncated or does not match its file name",
    )
}

pub(super) fn image_too_large() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "image_too_large",
        "Image dimensions exceed the allowed limit",
    )
}

pub(super) fn invalid_path() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_path",
        "Image path is not a safe relative workspace path",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn detects_supported_magic() {
        assert_eq!(detect_kind(PNG), Some(ImageKind::Png));
        assert_eq!(detect_kind(&[0xff, 0xd8, 0xff, 0]), Some(ImageKind::Jpeg));
        assert_eq!(detect_kind(b"GIF89a"), Some(ImageKind::Gif));
        assert_eq!(detect_kind(b"RIFF\0\0\0\0WEBP"), Some(ImageKind::Webp));
        assert_eq!(
            detect_kind(b"\0\0\0\x18ftypavif\0\0\0\0"),
            Some(ImageKind::Avif)
        );
    }

    #[test]
    fn rejects_mismatched_extension_and_unsafe_names() {
        assert!(inspect("photo.jpg", PNG).is_err());
        assert!(inspect("photo.svg", b"<svg/>").is_err());
        assert!(validate_file_name("a/b.png").is_err());
        assert!(validate_file_name("CON.png").is_err());
        assert!(validate_file_name("photo.png.").is_err());
    }

    #[test]
    fn reads_dimensions_from_supported_fixtures() {
        for (name, bytes, width, height) in [
            (
                "tiny.png",
                include_bytes!("../../testdata/images/tiny.png").as_slice(),
                2,
                3,
            ),
            (
                "tiny.jpg",
                include_bytes!("../../testdata/images/tiny.jpg").as_slice(),
                2,
                3,
            ),
            (
                "tiny.gif",
                include_bytes!("../../testdata/images/tiny.gif").as_slice(),
                2,
                3,
            ),
            (
                "tiny.webp",
                include_bytes!("../../testdata/images/tiny.webp").as_slice(),
                2,
                3,
            ),
        ] {
            let info = inspect(name, bytes).unwrap_or_else(|_| panic!("{name}"));
            assert_eq!((info.width, info.height), (width, height), "{name}");
        }
    }

    #[test]
    fn normalizes_directory_and_checks_file_names() {
        assert_eq!(validate_directory("notes/assets/").unwrap(), "notes/assets");
        assert!(validate_directory("../assets").is_err());
        assert!(validate_file_name("photo.png").is_ok());
        assert!(validate_file_name("photo.PNG").is_ok());
    }
}
