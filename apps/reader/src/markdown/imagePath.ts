export const inlineImagePattern = /\.(?:avif|gif|jpe?g|png|webp)$/iu;

export function isInlineImagePath(path: string) {
  return inlineImagePattern.test(path);
}
