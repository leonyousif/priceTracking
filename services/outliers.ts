/**
 * Outlier & Accessory Detection Engine
 * Uses word-boundary case-insensitive regex matching to filter out:
 * 1. Accessories (empty boxes, cables, brackets, broken items, replacement fans)
 * 2. Multi-variation dropdown listings (titles cramming multiple GPU models or console generations)
 */

export const DEFAULT_NEGATIVE_KEYWORDS: readonly string[] = [
  'box only',
  'empty box',
  'box',
  'case only',
  'parts only',
  'for parts',
  'not working',
  'non working',
  'non-working',
  'damaged',
  'broken',
  'faulty',
  'repair',
  'needs repair',
  'with issues',
  'as is',
  'fan',
  'fans',
  'bracket',
  'brackets',
  'cable',
  'cables',
  'cord',
  'cords',
  'sticker',
  'stickers',
  'manual',
  'manuals',
  'replacement',
  'cooler only',
  'heatsink',
  'dummy',
  'replica',
  // Water cooling & GPU accessories
  'water block',
  'waterblock',
  'backplate',
  'back plate',
  'anti-sag',
  'riser cable',
  'thermal pad',
  'thermal pads',
  // Console accessories & covers
  'console cover',
  'console covers',
  'faceplate',
  'faceplates',
  'side plates',
  'side plate',
  'replacement shell',
  'console skin',
  'disc drive',
  'accessories bundle',
  'accessory bundle',
  'no console',
  'console not included',
  'without console',
  'remote player',
  // Multi-variation dropdown phrases
  'choose model',
  'select model',
  'choose one',
  'options available',
  'multiple options',
  'pick your',
  'select one',
  'choose your',
];

/**
 * Escapes regex special characters in a literal string.
 */
function escapeRegex(text: string): string {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

/**
 * Parses a comma-separated list of custom negative keywords into a trimmed array.
 */
export function parseCustomKeywords(customKeywords?: string | null): string[] {
  if (!customKeywords || typeof customKeywords !== 'string') {
    return [];
  }
  return customKeywords
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export interface OutlierCheckResult {
  isOutlier: boolean;
  matchedKeyword?: string;
}

export type OutlierPolicy = (title: string) => OutlierCheckResult;

/**
 * Detects multi-variation titles that cram multiple different model tiers or generations.
 * e.g. "For Clevo GTX1070 MXM RTX2060 MXM RTX2070 RTX3060 RTX3070 RTX3080"
 */
export function hasConflictingMultipleModels(title: string): boolean {
  // Check for 2 or more distinct GPU model mentions (e.g. GTX 1070 + RTX 3080)
  const gpuMatches =
    title.match(/\b(?:rtx|gtx|rx)\s*\d{3,4}(?:\s*ti|\s*super|\s*xt)?\b/gi) || [];
  const normalizedGpus = new Set(
    gpuMatches.map((m) => m.toLowerCase().replace(/\s+/g, ''))
  );
  if (normalizedGpus.size >= 2) {
    return true;
  }

  // Check for 2 or more distinct PlayStation generations (e.g. PS4 and PS5 in one title)
  const psMatches =
    title.match(/\b(?:playstation\s*[1-5]|ps[1-5])\b/gi) || [];
  const normalizedPs = new Set(
    psMatches.map((m) => m.toLowerCase().replace(/playstation\s*/, 'ps').replace(/\s+/g, ''))
  );
  if (normalizedPs.size >= 2) {
    return true;
  }

  return false;
}

/**
 * Checks whether a listing title matches any negative keywords or multi-variation dropdown patterns.
 */
export function compileOutlierPolicy(customKeywords?: string | null): OutlierPolicy {
  const custom = parseCustomKeywords(customKeywords);
  const allKeywords = [...DEFAULT_NEGATIVE_KEYWORDS, ...custom];
  // Check from longest to shortest keyword for descriptive reporting
  const sorted = [...new Set(allKeywords)].sort((a, b) => b.length - a.length);
  const rules = sorted.map((kw) => {
    const escaped = escapeRegex(kw).replace(/\\\s+/g, '\\s+');
    return { keyword: kw, regex: new RegExp(`\\b${escaped}\\b`, 'i') };
  });
  return (title) => {
    if (!title || typeof title !== 'string') {
      return { isOutlier: true, matchedKeyword: 'EMPTY_TITLE' };
    }
    if (hasConflictingMultipleModels(title)) {
      return { isOutlier: true, matchedKeyword: 'MULTI_MODEL_DROPDOWN' };
    }
    for (const { keyword, regex } of rules) {
      if (regex.test(title)) {
        // A complete product can legitimately include its original box.
        if (keyword === 'box' &&
            /\b(?:with|in|comes\s+with|includes|including)\s+(?:original\s+|the\s+)?box\b/i.test(title)) continue;
        return { isOutlier: true, matchedKeyword: keyword };
      }
    }
    return { isOutlier: false };
  };
}

export function isOutlierOrAccessory(title: string, customKeywords?: string | null): OutlierCheckResult {
  return compileOutlierPolicy(customKeywords)(title);
}
