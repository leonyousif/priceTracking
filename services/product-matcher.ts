/**
 * Product Matcher & Anti-Spam Filtering Engine
 *
 * Ensures scraped marketplace listings strictly match the tracked product before
 * they are admitted into SQLite database storage, statistical market baselines, or active deals.
 *
 * Prevents false positives caused by:
 * 1. Console covers / faceplates / skins / shells / plates
 * 2. Standalone controllers & accessories
 * 3. Standalone video games & game discs
 * 4. PlayStation Portal & remote player streaming devices
 * 5. Older generation consoles (PS4, PS3, PS2, PSP, Vita, PS1)
 * 6. Different GPU tiers / SKUs (e.g. RTX 3080 vs RTX 3080 Ti)
 * 7. GPU hardware accessories (waterblocks, backplates, brackets, replacement fans, riser cables)
 * 8. Multi-variation dropdown listings and disclaimer listings ("no console", "for parts")
 */

import { compileOutlierPolicy } from './outliers';

export interface ProductMatchOptions {
  query: string;
  category?: string;
  negativeKeywords?: string | null;
}

export interface ProductMatchResult {
  isMatch: boolean;
  reason?: string;
  matchedPattern?: string;
}

export type ProductMatchPolicy = (title: string) => ProductMatchResult;

export interface RejectPatternRule {
  pattern: RegExp;
  reason: string;
  matchedPattern: string;
  excludePattern?: RegExp;
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'for', 'with', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'is']);
const GPU_GENERIC_WORDS = new Set(['gpu', 'gpus', 'graphics', 'video', 'card', 'cards', 'geforce', 'radeon', 'nvidia', 'amd']);

const CONSOLE_CATEGORY_TERMS = new Set([
  'console',
  'consoles',
  'video game console',
  'video game consoles',
  'gaming console',
  'gaming consoles',
]);

const GPU_CATEGORY_TERMS = new Set([
  'gpu',
  'gpus',
  'graphics card',
  'graphics cards',
  'video card',
  'video cards',
]);

const LAPTOP_CATEGORY_TERMS = new Set([
  'laptop',
  'laptops',
  'notebook',
  'notebooks',
]);

/** Universal disclaimer rejection rules ("NO CONSOLE", "without console", "console not included"). */
const UNIVERSAL_DISCLAIMER_RULES: readonly RejectPatternRule[] = [
  {
    pattern: /\b(?:no\s+console|console\s+(?:not\s+included|excluded|is\s+not\s+included)|without\s+(?:a\s+)?console|no\s+system)\b/i,
    reason: 'NO_CONSOLE_DISCLAIMER',
    matchedPattern: 'no console disclaimer',
  },
];

/** Older PlayStation generations masquerading under generic "PlayStation" terms. */
const OLDER_PLAYSTATION_RULES: readonly RejectPatternRule[] = [
  {
    pattern: /\b(?:psp|playstation\s*portable)\b/i,
    reason: 'OLDER_CONSOLE_PSP',
    matchedPattern: 'PlayStation Portable / PSP',
  },
  {
    pattern: /\b(?:ps\s*vita|playstation\s*vita|psvita)\b/i,
    reason: 'OLDER_CONSOLE_VITA',
    matchedPattern: 'PS Vita',
  },
  {
    pattern: /\b(?:ps1|playstation\s*1|psone)\b/i,
    reason: 'OLDER_CONSOLE_PS1',
    matchedPattern: 'PlayStation 1',
  },
  {
    pattern: /\b(?:ps2|playstation\s*2|scph-\d+)\b/i,
    reason: 'OLDER_CONSOLE_PS2',
    matchedPattern: 'PlayStation 2',
  },
  {
    pattern: /\b(?:ps3|playstation\s*3|cech-\d+)\b/i,
    reason: 'OLDER_CONSOLE_PS3',
    matchedPattern: 'PlayStation 3',
  },
  {
    pattern: /\b(?:ps4|playstation\s*4|cuh-\d+)\b/i,
    reason: 'OLDER_CONSOLE_PS4',
    matchedPattern: 'PlayStation 4',
  },
];

/** PS5 remote devices, covers, faceplates, shells, and skins. */
const PS5_PORTAL_AND_COVER_RULES: readonly RejectPatternRule[] = [
  {
    pattern: /\b(?:portal|remote\s*player)\b/i,
    reason: 'PORTAL_DEVICE',
    matchedPattern: 'PlayStation Portal / Remote Player',
  },
  {
    pattern: /\b(?:console\s+covers?|covers?|faceplates?|face\s+plates?|side\s+plates?|plates?|shells?|housing|skins?|decals?|wrap|wraps)\b/i,
    reason: 'CONSOLE_COVER',
    matchedPattern: 'Cover, Faceplate, Plate, Shell, or Skin accessory',
  },
];

/** PS5 hardware accessories, docks, add-ons, and bags. */
const PS5_HARDWARE_ACCESSORY_RULES: readonly RejectPatternRule[] = [
  {
    pattern: /\bdisc\s+drive\b/i,
    reason: 'DISC_DRIVE_ACCESSORY',
    matchedPattern: 'PS5 standalone disc drive accessory',
  },
  {
    pattern: /\b(?:vertical\s+stand|cooling\s+stand|charging\s+dock|charging\s+station|docking\s+station|wall\s+mount)\b/i,
    reason: 'CONSOLE_STAND_OR_DOCK',
    matchedPattern: 'Stand, Dock, or Charging Station accessory',
  },
  {
    pattern: /\b(?:headset|headphones|pulse\s*3d|pulse\s*explore|pulse\s*elite|earbuds|playstation\s*vr|psvr|psvr2|vr2|hd\s+camera|webcam|camera\s+adapter|racing\s*wheel|steering\s*wheel)\b/i,
    reason: 'CONSOLE_HARDWARE_ACCESSORY',
    matchedPattern: 'Headset, VR, Camera, or Wheel accessory',
  },
  {
    pattern: /\b(?:carrying\s*case|travel\s*case|travel\s*bag|storage\s*bag|backpack|protective\s*case)\b/i,
    reason: 'CONSOLE_CASE',
    matchedPattern: 'Carrying case or bag',
  },
  {
    pattern: /\b(?:accessories\s+bundle|accessory\s+(?:kit|pack|bundle)|accessories)\b/i,
    excludePattern: /\b(?:console\s+bundle)\b/i,
    reason: 'ACCESSORIES_BUNDLE',
    matchedPattern: 'Accessories bundle',
  },
  {
    pattern: /\b(?:for|fits?|compatible\s+with)\s+(?:the\s+)?(?:ps5|playstation\s*5)\s+console\b/i,
    reason: 'ACCESSORY_FOR_CONSOLE',
    matchedPattern: 'Accessory designed for PS5 console',
  },
];

/** GPU hardware accessories (waterblocks, backplates, replacement fans, brackets, cables, pads). */
const GPU_ACCESSORY_RULES: readonly RejectPatternRule[] = [
  {
    pattern: /\b(?:water\s*block|waterblock|liquid\s*cooler|water\s*cooling|ek-quantum|alphacool|bykski|corsair\s*hydro|block\s*only)\b/i,
    reason: 'GPU_WATERBLOCK',
    matchedPattern: 'Water block / liquid cooling block accessory',
  },
  {
    pattern: /\b(?:backplate|back\s*plate|back-plate)\b/i,
    reason: 'GPU_BACKPLATE',
    matchedPattern: 'GPU backplate accessory',
  },
  {
    pattern: /\b(?:replacement\s*fans?|cooler\s*only|heatsink|heat\s*sink|radiator|shroud\s*only|fan\s*replacement|cooling\s*fan\s*for)\b/i,
    reason: 'GPU_COOLER_OR_FAN',
    matchedPattern: 'Replacement fan, heatsink, or cooler shroud accessory',
  },
  {
    pattern: /\b(?:anti-sag|anti\s*sag|sag\s*bracket|gpu\s*bracket|support\s*bracket|gpu\s*brace|support\s*holder)\b/i,
    reason: 'GPU_BRACKET',
    matchedPattern: 'Anti-sag GPU bracket or support holder',
  },
  {
    pattern: /\b(?:riser\s*cable|pcie\s*cable|power\s*cable|12vhpwr|adapter\s*cable|power\s*cord)\b/i,
    reason: 'GPU_CABLE',
    matchedPattern: 'PCIe, Riser, or power cable accessory',
  },
  {
    pattern: /\b(?:thermal\s*pads?|thermal\s*paste)\b/i,
    reason: 'GPU_THERMAL_PADS',
    matchedPattern: 'Thermal pad or paste accessory',
  },
];

/** Evaluates a list of reject rules against a title, returning the first matching rejection. */
function matchRejectRule(title: string, rules: readonly RejectPatternRule[]): ProductMatchResult | null {
  for (const rule of rules) {
    if (rule.pattern.test(title) && (!rule.excludePattern || !rule.excludePattern.test(title))) {
      return {
        isMatch: false,
        reason: rule.reason,
        matchedPattern: rule.matchedPattern,
      };
    }
  }
  return null;
}

/** Normalize identity separators without loosening model-number boundaries. */
function normalizeGpuText(text: string): string {
  return text.toLowerCase().replace(/\b(rtx|gtx|rx)[\s-]*(\d{3,4})(?=\b|(?:ti|super|xt)\b)/g, '$1 $2')
    .replace(/\b(\d{3,4})(ti|super|xt)\b/g, '$1 $2').replace(/\bfe\b/g, 'founders edition');
}

/**
 * Maps known search categories and queries to eBay Category IDs (_sacat)
 * to constrain search results at the marketplace level.
 */
export function getEbayCategoryId(
  category?: string | null,
  query?: string | null
): string | null {
  const normCat = category ? category.trim().toLowerCase() : '';
  const normQuery = query ? query.trim().toLowerCase() : '';

  // 1. Direct numeric Category ID
  if (/^\d+$/.test(normCat)) {
    return normCat;
  }

  // 2. Video Game Consoles (eBay Category 139971)
  if (
    CONSOLE_CATEGORY_TERMS.has(normCat) ||
    (/\b(?:ps5|playstation\s*5|xbox|switch)\b/i.test(normQuery) &&
      (/\bconsole\b/i.test(normQuery) || normCat === 'console'))
  ) {
    return '139971';
  }

  // 3. Graphics / Video Cards (eBay Category 27386)
  if (
    GPU_CATEGORY_TERMS.has(normCat) ||
    (/\b(?:rtx|gtx|rx)\s*\d{3,4}\b/i.test(normQuery) &&
      (normCat === 'gpu' || normCat === 'components'))
  ) {
    return '27386';
  }

  // 4. Laptops & Netbooks (eBay Category 175672)
  if (LAPTOP_CATEGORY_TERMS.has(normCat)) {
    return '175672';
  }

  return null;
}

/**
 * Checks whether the target search represents a PlayStation 5 Console search.
 */
export function isPs5ConsoleTarget(query: string, category?: string): boolean {
  const q = query.toLowerCase();
  const c = category ? category.toLowerCase() : '';

  const hasPs5Token = /\b(?:ps5|playstation\s*5)\b/i.test(q);
  const isConsoleScope =
    /\bconsole\b/i.test(q) ||
    c.includes('console') ||
    c === 'gaming' ||
    q.trim() === 'ps5' ||
    q.trim() === 'playstation 5';

  return hasPs5Token && isConsoleScope;
}

/**
 * Checks whether the target search represents a GPU search.
 */
export function isGpuTarget(query: string, category?: string): boolean {
  const q = normalizeGpuText(query);
  const c = category ? category.toLowerCase() : '';

  return (
    /\b(?:rtx|gtx|rx)\s*\d{3,4}\b/i.test(q) ||
    c === 'gpu' ||
    c.includes('graphics') ||
    c.includes('video card')
  );
}

/**
 * Evaluates whether an extracted listing title accurately matches the tracked product target.
 */
export function compileProductMatchPolicy(target: ProductMatchOptions): ProductMatchPolicy {
  const checkOutlier = compileOutlierPolicy(target.negativeKeywords);
  const ps5Target = isPs5ConsoleTarget(target.query, target.category);
  const gpuTarget = isGpuTarget(target.query, target.category);
  const normalizedQuery = normalizeGpuText(target.query);
  const identity = normalizedQuery.match(/\b(rtx|gtx|rx)\s+(\d{3,4})\b/);
  const family = identity?.[1] ?? normalizedQuery.match(/\b(rtx|gtx|rx)\b/)?.[1] ?? null;
  const targetModel = identity?.[2] ?? (family ? null : normalizedQuery.match(/\b(\d{3,4})\b/)?.[1] ?? null);
  // Broad GPU/family/vendor queries are intentional. An unparsed numeric target fails closed.
  const broadGpu = !/\d/.test(normalizedQuery) && /\b(?:rtx|gtx|rx|gpu|gpus|graphics|video\s+cards?|nvidia|amd|geforce|radeon)\b/.test(normalizedQuery);
  const gpuModelRegex = targetModel ? new RegExp(`\\b${targetModel}\\b`, 'i') : null;
  const gpuVariants = targetModel ? [
    { suffix: 'ti', required: /\bti\b/i.test(normalizedQuery), pattern: new RegExp(`\\b${targetModel}\\s*ti\\b`, 'i'), mismatch: 'GPU_TI_MISMATCH', missing: 'GPU_NON_TI_MISMATCH' },
    { suffix: 'super', required: /\bsuper\b/i.test(normalizedQuery), pattern: new RegExp(`\\b${targetModel}\\s*super\\b`, 'i'), mismatch: 'GPU_SUPER_MISMATCH', missing: 'GPU_NON_SUPER_MISMATCH' },
    { suffix: 'xt', required: /\bxt\b/i.test(normalizedQuery), pattern: new RegExp(`\\b${targetModel}\\s*xt\\b`, 'i'), mismatch: 'GPU_XT_MISMATCH', missing: 'GPU_NON_XT_MISMATCH' },
  ] : [];
  const queryTokens = !ps5Target ? (gpuTarget ? normalizedQuery : target.query.toLowerCase())
    .replace(/[^\w\s]/g, ' ').split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .filter((token) => !gpuTarget || (!GPU_GENERIC_WORDS.has(token) && !['rtx', 'gtx', 'rx', targetModel].includes(token) &&
      !(targetModel && ['ti', 'super', 'xt'].includes(token))))
    .map((token) => ({ token, pattern: new RegExp(`\\b${token}\\b`, 'i') })) : [];

  return (title: string): ProductMatchResult => {
    if (!title || typeof title !== 'string' || !title.trim()) {
      return { isMatch: false, reason: 'EMPTY_TITLE' };
    }

    const cleanTitle = gpuTarget ? normalizeGpuText(title.trim()) : title.trim();

    // 1. Universal Negative & Outlier Checks (parts, repairs, dropdowns, broken)
    const baseOutlier = checkOutlier(cleanTitle);
    if (baseOutlier.isOutlier) {
      return {
        isMatch: false,
        reason: 'UNIVERSAL_OUTLIER',
        matchedPattern: baseOutlier.matchedKeyword,
      };
    }

    // 2. Explicit Disclaimer Phrases ("NO CONSOLE", "without console", "console not included")
    const disclaimerMatch = matchRejectRule(cleanTitle, UNIVERSAL_DISCLAIMER_RULES);
    if (disclaimerMatch) {
      return disclaimerMatch;
    }

    // -------------------------------------------------------------
    // PlayStation 5 Console Target Matching Rules
    // -------------------------------------------------------------
    if (ps5Target) {
      // 3a. Older PlayStation Generation Detection (PS4, PS3, PS2, PS1, PSP, PS Vita)
      const olderPsMatch = matchRejectRule(cleanTitle, OLDER_PLAYSTATION_RULES);
      if (olderPsMatch) {
        return olderPsMatch;
      }

      // Must explicitly identify as PlayStation 5 / PS5
      if (!/\b(?:ps5|playstation\s*5)\b/i.test(cleanTitle)) {
        return {
          isMatch: false,
          reason: 'MISSING_PS5_TOKEN',
          matchedPattern: 'Requires PS5 or PlayStation 5 token',
        };
      }

      // 3b/3c. PlayStation Portal Devices & Console Covers / Faceplates
      const portalOrCoverMatch = matchRejectRule(cleanTitle, PS5_PORTAL_AND_COVER_RULES);
      if (portalOrCoverMatch) {
        return portalOrCoverMatch;
      }

      // 3d. Standalone Controllers vs Console Bundles
      // Reject listings that are solely controllers (DualSense)
      const hasControllerToken =
        /\b(?:controller|controllers|dualsense|dual\s*sense|gamepad|joypad)\b/i.test(
          cleanTitle
        );

      if (hasControllerToken) {
        const hasConsoleToken = /\b(?:console|system)\b/i.test(cleanTitle);

        // If it doesn't even say "console", it's purely a controller
        if (!hasConsoleToken) {
          return {
            isMatch: false,
            reason: 'CONTROLLER_STANDALONE',
            matchedPattern: 'DualSense / Controller without console token',
          };
        }

        // If it's a controller "for PS5 console"
        if (
          /\b(?:controller|dualsense|dual\s*sense)\s+(?:for|fits?|compatible\s+with)\s+(?:the\s+)?(?:ps5|playstation\s*5|console)\b/i.test(
            cleanTitle
          )
        ) {
          return {
            isMatch: false,
            reason: 'CONTROLLER_FOR_CONSOLE',
            matchedPattern: 'Controller for PS5 console',
          };
        }

        // If the title starts with the controller as the subject
        if (
          /^(?:new\s+|sony\s+|official\s+)?(?:dualsense|controller|wireless\s+controller)\b/i.test(
            cleanTitle
          ) &&
          !/\b(?:console\s+bundle|bundle\s+with|with\s+(?:2|two|extra)\s+controllers?)\b/i.test(
            cleanTitle
          )
        ) {
          return {
            isMatch: false,
            reason: 'CONTROLLER_STANDALONE',
            matchedPattern: 'Title lead with controller subject',
          };
        }
      }

      // 3e. Standalone Video Games
      // Standalone games (e.g. "Spider-Man 2 PS5 Game Disc") must not enter console searches
      if (
        /\bconsole\s+edition\b/i.test(cleanTitle) &&
        !/\bconsole\s+(?:bundle|with)\b|\bconsole\s*\+/i.test(cleanTitle)
      ) {
        return {
          isMatch: false,
          reason: 'GAME_STANDALONE',
          matchedPattern: 'Console Edition game without console bundle',
        };
      }

      const hasGameToken =
        /\b(?:game\s*disc|video\s*game|sealed\s*game|game\s*cartridge|game\s*card)\b/i.test(
          cleanTitle
        );
      if (hasGameToken && !/\b(?:console|system|bundle)\b/i.test(cleanTitle)) {
        return {
          isMatch: false,
          reason: 'GAME_STANDALONE',
          matchedPattern: 'Standalone game disc without console token',
        };
      }

      // Game lots (e.g. "Lot of 5 PS5 Games")
      if (
        /\b(?:lot\s+of\s+\d+|\d+\s*games?)\b/i.test(cleanTitle) &&
        !/\b(?:console|system)\b/i.test(cleanTitle)
      ) {
        return {
          isMatch: false,
          reason: 'GAME_LOT',
          matchedPattern: 'Game lot without console token',
        };
      }

      // 3f. Other Hardware Accessories & Add-ons
      const accessoryMatch = matchRejectRule(cleanTitle, PS5_HARDWARE_ACCESSORY_RULES);
      if (accessoryMatch) {
        return accessoryMatch;
      }

      // 3g. Positive PS5 Console Requirement
      // Must contain "console", "system", or a recognized PS5 hardware model / edition
      const hasConsoleIndicator =
        /\b(?:console|system|disc\s+edition|digital\s+edition|slim|pro|cfi-\d+)\b/i.test(
          cleanTitle
        );
      if (!hasConsoleIndicator) {
        return {
          isMatch: false,
          reason: 'NOT_A_PS5_CONSOLE',
          matchedPattern: 'Missing console, edition, or hardware model designation',
        };
      }

      return { isMatch: true };
    }

    // -------------------------------------------------------------
    // GPU Target Matching Rules (RTX 3080 vs 3080 Ti & Accessories)
    // -------------------------------------------------------------
    if (gpuTarget) {
      if (!targetModel && !broadGpu) return { isMatch: false, reason: 'GPU_TARGET_UNPARSEABLE' };
      const titleIdentity = cleanTitle.match(/\b(rtx|gtx|rx)\s+(\d{3,4})\b/);
      if (!titleIdentity) return { isMatch: false, reason: 'GPU_MODEL_MISMATCH' };
      if ((family && family !== titleIdentity[1]) ||
          (/\bnvidia\b/.test(normalizedQuery) && titleIdentity[1] === 'rx') ||
          (/\b(?:amd|radeon)\b/.test(normalizedQuery) && titleIdentity[1] !== 'rx')) {
        return { isMatch: false, reason: 'GPU_FAMILY_MISMATCH' };
      }
      if (targetModel) {
        // Must contain target model number (e.g. 3080)
        if (!gpuModelRegex!.test(cleanTitle)) {
          return {
            isMatch: false,
            reason: 'GPU_MODEL_MISMATCH',
            matchedPattern: `Title does not contain GPU model ${targetModel}`,
          };
        }

        // Keep Ti, Super, XT precedence and the existing rejection reasons.
        for (const variant of gpuVariants) {
          const present = variant.pattern.test(cleanTitle);
          if (present === variant.required) continue;
          const suffix = variant.suffix === 'ti' ? 'Ti' : variant.suffix === 'xt' ? 'XT' : 'Super';
          return {
            isMatch: false,
            reason: present ? variant.mismatch : variant.missing,
            matchedPattern: present
              ? `${targetModel} ${suffix} found when tracking ${variant.suffix === 'ti' ? `non-Ti ${targetModel}` : 'standard model'}`
              : `Expected ${targetModel} ${suffix}, but title is non-${suffix}`,
          };
        }
      }

      // GPU Hardware Accessories Filtering
      const gpuAccessoryMatch = matchRejectRule(cleanTitle, GPU_ACCESSORY_RULES);
      if (gpuAccessoryMatch) {
        return gpuAccessoryMatch;
      }

      // Generic "for [model]" accessory phrase
      if (
        /\b(?:for|fits?|compatible\s+with)\s+(?:nvidia\s+)?(?:geforce\s+)?(?:rtx|gtx|rx)?\s*\d{3,4}\b/i.test(
          cleanTitle
        ) &&
        /\b(?:cooler|fan|bracket|plate|block|cable|shroud|cover|case)\b/i.test(cleanTitle)
      ) {
        return {
          isMatch: false,
          reason: 'GPU_ACCESSORY_FOR_MODEL',
          matchedPattern: 'Accessory component for GPU',
        };
      }
    }

    // -------------------------------------------------------------
    // General Query Token Fallback
    // -------------------------------------------------------------
    // Retain specific brand/edition terms for GPUs as well as ordinary query terms.
    const lowerTitle = cleanTitle.toLowerCase();
    for (const { token, pattern } of queryTokens) {
      if (!pattern.test(lowerTitle)) {
        return {
          isMatch: false,
          reason: 'QUERY_TERMS_MISSING',
          matchedPattern: `Missing essential query token: ${token}`,
        };
      }
    }

    return { isMatch: true };
  };
}

export function isProductMatch(title: string, target: ProductMatchOptions): ProductMatchResult {
  return compileProductMatchPolicy(target)(title);
}
