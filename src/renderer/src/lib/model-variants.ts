export interface ModelVariantMetadata {
  variants?: Record<string, Record<string, unknown>>
  defaultVariant?: string
}

export function getVariantKeys(model: ModelVariantMetadata): string[] {
  if (!model.variants) return []
  return Object.keys(model.variants)
}

export function resolveModelVariantForSelection(
  model: ModelVariantMetadata,
  remembered?: string
): string | undefined {
  const variantKeys = getVariantKeys(model)
  return remembered && variantKeys.includes(remembered)
    ? remembered
    : model.defaultVariant && variantKeys.includes(model.defaultVariant)
      ? model.defaultVariant
    : variantKeys.length > 0
      ? variantKeys[0]
      : undefined
}
