import { ApiError } from "../../api/client";
import type { AssetUpload } from "../../api/client";
import { relativeAssetPath } from "../../markdown/relativePath";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGES = 8;

const imageExtension = /\.(?:png|jpe?g|webp|gif|avif)$/iu;

export function assetsDirectory(documentPath: string) {
  const slash = documentPath.lastIndexOf("/");
  return slash < 0 ? "assets" : `${documentPath.slice(0, slash)}/assets`;
}

export function imageValidationError(files: readonly File[]) {
  if (files.length === 0) return "请选择图片。";
  if (files.length > MAX_IMAGES) return `一次最多插入 ${MAX_IMAGES} 张图片。`;
  for (const file of files) {
    if (!imageExtension.test(file.name)) {
      return `${file.name}：仅支持 PNG、JPEG、WebP、GIF 和 AVIF。`;
    }
    if (file.size === 0) return `${file.name}：图片为空。`;
    if (file.size > MAX_IMAGE_BYTES) return `${file.name}：单张图片最多 12 MiB。`;
  }
  return undefined;
}

function encodeMarkdownPath(path: string) {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function escapeAlt(text: string) {
  return text.replace(/[\\[\]]/gu, (character) => `\\${character}`);
}

function altText(path: string) {
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.[^.]+$/u, "") || name;
}

export function markdownForImages(documentPath: string, assets: readonly AssetUpload[]) {
  return assets
    .map((asset) => {
      const path = encodeMarkdownPath(relativeAssetPath(documentPath, asset.path));
      return `![${escapeAlt(altText(asset.path))}](${path})`;
    })
    .join("\n\n");
}

export function imageUploadError(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unsupported_image_type":
        return "仅支持 PNG、JPEG、WebP、GIF 和 AVIF 图片。";
      case "invalid_image":
        return "图片内容损坏，或与文件扩展名不一致。";
      case "image_too_large":
        return "图片宽高或像素超过限制，请先缩小再上传。";
      case "asset_too_large":
        return "图片超过 12 MiB，请压缩后再上传。";
      case "asset_path_exists":
        return "已有同名图片，请重命名后重试。";
      case "read_only":
        return "当前空间只读，无法上传图片。";
      case "invalid_path":
        return "图片文件名或目录不安全，请重命名后重试。";
      case "unauthorized":
        return "登录已失效，请重新登录后再上传。";
      default:
        return `图片上传失败：${error.message}`;
    }
  }
  return error instanceof Error ? error.message : "图片上传失败，请重试。";
}
