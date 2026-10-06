/**
 * Pricing & Postage Extraction and Calculation Engine
 * 
 * Responsibilities:
 * 1. Extract item price and postage amounts in AUD.
 * 2. Handle displayed AUD conversions (e.g. "US $33.00 (approx. AU $46.99)")
 *    without treating foreign currency amounts (e.g. US $33.00) as AUD.
 * 3. Extract postage when available (including free postage = 0.00).
 * 4. Represent unknown postage explicitly as null.
 * 5. Calculate buyer's estimated delivered cost (itemPrice + postage).
 * 6. Explicitly identify incomplete prices (null delivered cost) so deals are never flagged from them.
 */

export interface ParsedPrice {
  amount: number | null; // AUD amount if available, otherwise null
  currency: string;      // 'AUD', 'USD', 'GBP', 'EUR', etc.
  rawAmount: number | null; // Original numeric digits found
  rawCurrency: string;   // Currency code of original price
  isConvertedAud: boolean; // True if extracted from an approx. AU $ conversion
  hasAudPrice: boolean;  // True if amount is a valid AUD price
}

export interface ParsedPostage {
  postage: number | null; // null = unknown/incomplete, 0 = free, >0 = postage in AUD
  isFree: boolean;
  isUnknown: boolean;
  currency: string;
  rawAmount: number | null;
  isConvertedAud: boolean;
}

/** Shared money boundary for parsed amounts and computed delivered costs. */
export function isFiniteMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 100;
}

function roundMoney(value: number): number | null {
  return isFiniteMoney(value) ? Math.round(value * 100) / 100 : null;
}

/**
 * Parses raw text to extract item price in AUD.
 * Accurately extracts displayed AUD conversions (e.g. "US $33.00 (approx. AU $46.99)").
 * Never treats raw foreign-currency amounts (e.g. "US $33.00", "EUR 45.00") as AUD.
 */
export function parsePrice(
  rawText: string | null | undefined,
  defaultCurrency = 'AUD'
): ParsedPrice {
  if (!rawText || typeof rawText !== 'string') {
    return {
      amount: null,
      currency: defaultCurrency,
      rawAmount: null,
      rawCurrency: defaultCurrency,
      isConvertedAud: false,
      hasAudPrice: false,
    };
  }

  const text = rawText.trim();

  // Multi-variation price range check (e.g. "AU $5.00 to AU $450.00" or "from $20")
  if (
    text.toLowerCase().includes(' to ') ||
    text.toLowerCase().includes(' until ') ||
    text.toLowerCase().includes('from ')
  ) {
    return {
      amount: null,
      currency: defaultCurrency,
      rawAmount: null,
      rawCurrency: defaultCurrency,
      isConvertedAud: false,
      hasAudPrice: false,
    };
  }

  // 1. Check for displayed approx AUD conversion:
  // e.g. "ApproximatelyAU $46.99", "(approx. AU $46.99)", "approx AU $46.99", "Approximately AU $46.99"
  const approxAudRegex =
    /(?:approx\.?|approximately)\s*(?:AU\s*\$|AUD\s*)\s*([\d,]+(?:\.\d{1,2})?)/i;
  const approxMatch = text.match(approxAudRegex);
  if (approxMatch) {
    const cleanNum = approxMatch[1].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    if (isFiniteMoney(num) && num > 0) {
      return {
        amount: roundMoney(num),
        currency: 'AUD',
        rawAmount: num,
        rawCurrency: 'AUD',
        isConvertedAud: true,
        hasAudPrice: true,
      };
    }
  }

  // 2. Check for explicit native AUD:
  // e.g. "AU $530.65", "AUD 530.65"
  const nativeAudRegex = /(?:AU\s*\$|AUD\s*)\s*([\d,]+(?:\.\d{1,2})?)/i;
  const nativeAudMatch = text.match(nativeAudRegex);
  if (nativeAudMatch) {
    const cleanNum = nativeAudMatch[1].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    if (isFiniteMoney(num) && num > 0) {
      return {
        amount: roundMoney(num),
        currency: 'AUD',
        rawAmount: num,
        rawCurrency: 'AUD',
        isConvertedAud: false,
        hasAudPrice: true,
      };
    }
  }

  // 3. Check for explicit foreign currency WITHOUT displayed AUD conversion:
  // e.g. "US $33.00", "USD 33.00", "EUR 45.00", "€45.00", "GBP 25.00", "£25.00", "CAD $30.00"
  const foreignCurrencyRegex =
    /(?:^|\b|\s)(US\s*\$|USD|EUR|GBP|CAD\s*\$|CAD|NZD\s*\$|NZD|JPY|[€£¥])\s*([\d,]+(?:\.\d{1,2})?)/i;
  const foreignMatch = text.match(foreignCurrencyRegex);
  if (foreignMatch) {
    const rawCurr = foreignMatch[1].trim().toUpperCase();
    const cleanNum = foreignMatch[2].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    // Explicitly do NOT treat as AUD!
    return {
      amount: null, // Foreign currency with no AUD conversion is unknown AUD
      currency: rawCurr.includes('US') ? 'USD' : rawCurr.includes('EUR') || rawCurr === '€' ? 'EUR' : rawCurr.includes('GBP') || rawCurr === '£' ? 'GBP' : rawCurr,
      rawAmount: roundMoney(num),
      rawCurrency: rawCurr,
      isConvertedAud: false,
      hasAudPrice: false,
    };
  }

  // 4. Default bare '$' on Australian marketplace (e.g. "$530.65")
  const bareDollarRegex = /(?:^|[^\w$])\$([\d,]+(?:\.\d{1,2})?)/i;
  const bareMatch = text.match(bareDollarRegex);
  if (bareMatch) {
    const cleanNum = bareMatch[1].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    if (isFiniteMoney(num) && num > 0) {
      return {
        amount: roundMoney(num),
        currency: defaultCurrency,
        rawAmount: num,
        rawCurrency: defaultCurrency,
        isConvertedAud: false,
        hasAudPrice: defaultCurrency === 'AUD',
      };
    }
  }

  return {
    amount: null,
    currency: defaultCurrency,
    rawAmount: null,
    rawCurrency: defaultCurrency,
    isConvertedAud: false,
    hasAudPrice: false,
  };
}

/**
 * Parses raw text to extract postage in AUD.
 * Handles free delivery, explicit AUD postage, approx AUD international postage,
 * foreign postage without conversion, and explicit unknown postage.
 */
export function parsePostage(
  rawText: string | null | undefined,
  defaultCurrency = 'AUD'
): ParsedPostage {
  if (!rawText || typeof rawText !== 'string') {
    return {
      postage: null,
      isFree: false,
      isUnknown: true,
      currency: defaultCurrency,
      rawAmount: null,
      isConvertedAud: false,
    };
  }

  const text = rawText.trim();

  // 1. Check for explicit unknown or pickup only markers
  const unknownMarkers = [
    'postage not specified',
    'may not post',
    'does not ship to australia',
    'collection in person',
    'pickup only',
    'local pickup',
    'freight',
    'ask seller for postage',
  ];
  const lower = text.toLowerCase();
  for (const marker of unknownMarkers) {
    if (lower.includes(marker)) {
      return {
        postage: null,
        isFree: false,
        isUnknown: true,
        currency: defaultCurrency,
        rawAmount: null,
        isConvertedAud: false,
      };
    }
  }

  // 2. Check for Free Postage / Delivery
  // e.g. "Free postage", "Free delivery", "Free shipping", "Free delivery by Fri 2 Oct", "Free International Shipping"
  if (
    /\bfree\s+(?:postage|delivery|shipping|standard\s+delivery|international\s+shipping)\b/i.test(
      text
    ) ||
    lower === 'free delivery' ||
    lower === 'free postage' ||
    lower === 'free shipping'
  ) {
    return {
      postage: 0,
      isFree: true,
      isUnknown: false,
      currency: 'AUD',
      rawAmount: 0,
      isConvertedAud: false,
    };
  }

  // 3. Check for approx AUD postage conversion:
  // e.g. "US $151.01 (approx. AU $215.02)", "(approx. AU $215.02)", "+US $15.00 (approx. AU $23.50) postage"
  const approxAudRegex =
    /(?:approx\.?|approximately)\s*(?:AU\s*\$|AUD\s*)\s*([\d,]+(?:\.\d{1,2})?)/i;
  const approxMatch = text.match(approxAudRegex);
  if (approxMatch) {
    const cleanNum = approxMatch[1].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    if (isFiniteMoney(num)) {
      return {
        postage: roundMoney(num),
        isFree: num === 0,
        isUnknown: false,
        currency: 'AUD',
        rawAmount: num,
        isConvertedAud: true,
      };
    }
  }

  // 4. Check for direct AUD postage:
  // e.g. "+AU $21.52 delivery", "AU $18.34 delivery in 2-4 days", "+AU $216.97 delivery", "+AU $108.72 postage estimate", "+AU $23.16 postage"
  const nativeAudRegex =
    /(?:\+\s*)?(?:AU\s*\$|AUD\s*)\s*([\d,]+(?:\.\d{1,2})?)/i;
  const nativeAudMatch = text.match(nativeAudRegex);
  if (nativeAudMatch) {
    const cleanNum = nativeAudMatch[1].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    if (isFiniteMoney(num)) {
      return {
        postage: roundMoney(num),
        isFree: num === 0,
        isUnknown: false,
        currency: 'AUD',
        rawAmount: num,
        isConvertedAud: false,
      };
    }
  }

  // 5. Check for foreign postage WITHOUT displayed AUD conversion:
  // e.g. "+US $15.00 postage", "EUR 20.00 shipping", "GBP 12.00", "£10.00"
  // DO NOT treat foreign postage as AUD!
  const foreignRegex =
    /(?:^|\b|\s)(US\s*\$|USD|EUR|GBP|CAD\s*\$|CAD|NZD\s*\$|NZD|JPY|[€£¥])\s*([\d,]+(?:\.\d{1,2})?)/i;
  const foreignMatch = text.match(foreignRegex);
  if (foreignMatch) {
    const rawCurr = foreignMatch[1].trim();
    const cleanNum = foreignMatch[2].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    return {
      postage: null, // Foreign currency with no AUD conversion is unknown AUD postage
      isFree: false,
      isUnknown: true,
      currency: rawCurr,
      rawAmount: isFiniteMoney(num) ? num : null,
      isConvertedAud: false,
    };
  }

  // 6. Generic bare dollar postage on Australian marketplace (e.g. "+$15.00 postage", "+$21.52 delivery")
  const bareDollarRegex =
    /(?:\+\s*)\$([\d,]+(?:\.\d{1,2})?)\s*(?:delivery|postage|shipping)?/i;
  const bareMatch = text.match(bareDollarRegex);
  if (bareMatch) {
    const cleanNum = bareMatch[1].replace(/,/g, '');
    const num = parseFloat(cleanNum);
    if (isFiniteMoney(num)) {
      return {
        postage: roundMoney(num),
        isFree: num === 0,
        isUnknown: false,
        currency: defaultCurrency,
        rawAmount: num,
        isConvertedAud: false,
      };
    }
  }

  // No identifiable postage found -> explicitly unknown
  return {
    postage: null,
    isFree: false,
    isUnknown: true,
    currency: defaultCurrency,
    rawAmount: null,
    isConvertedAud: false,
  };
}

/**
 * Calculates the buyer's estimated delivered cost: itemPrice + postage.
 * If postage is null (unknown/incomplete) or itemPrice is null, returns null.
 * A null delivered cost represents an incomplete price.
 */
export function calculateDeliveredCost(
  itemPrice: number | null | undefined,
  postage: number | null | undefined
): number | null {
  if (!isFiniteMoney(itemPrice) || itemPrice <= 0 || !isFiniteMoney(postage)) return null;
  return roundMoney(itemPrice + postage);
}

/** One AUD pricing policy for search cards and item pages, after DOM extraction. */
export function parseListingPricing(
  rawPriceText: string,
  rawShippingText: string,
  defaultCurrency = 'AUD'
): {
  itemPrice: number | null;
  postage: number | null;
  estimatedDeliveredCost: number | null;
  currency: string;
} {
  const price = parsePrice(rawPriceText, defaultCurrency);
  const shipping = parsePostage(rawShippingText, defaultCurrency);
  const itemPrice = price.hasAudPrice ? price.amount : null;
  const postage = shipping.currency === 'AUD' ? shipping.postage : null;
  return {
    itemPrice,
    postage,
    estimatedDeliveredCost: calculateDeliveredCost(itemPrice, postage),
    currency: price.currency,
  };
}
