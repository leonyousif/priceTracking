/**
 * Defensive manual validation using type narrowing and the Result Object Pattern.
 */

import {
  CreateTrackedSearchInput,
  UpdateTrackedSearchInput,
  PaginationQuery,
  ListingSortOption,
  ValidationResult,
} from './types';

// Primitive Guard & Sanitization Helpers

export function isNumber(val: unknown): val is number {
  return typeof val === 'number' && !Number.isNaN(val) && Number.isFinite(val);
}

/** Parse a complete decimal value; never accept numeric prefixes or coercible objects. */
export function parseNumber(val: unknown): number | undefined {
  if (typeof val === 'string') {
    const text = val.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
    val = Number(text);
  }
  return isNumber(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER ? val : undefined;
}

export function parseId(val: unknown): number | undefined {
  if (typeof val === 'string' && !/^[1-9]\d*$/.test(val.trim())) return undefined;
  const parsed = parseNumber(val);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function invalidBody(): ValidationResult<never> {
  return { success: false, errors: { body: ['Request body must be a valid JSON object'] } };
}

export function parseBoolean(val: unknown): boolean | undefined {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  if (typeof val === 'number') {
    if (val === 1) return true;
    if (val === 0) return false;
  }
  return undefined;
}

export function sanitizeString(val: string): string {
  return val.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

// Create and update share the same field policy; only required fields/defaults differ.
function validateSearchFields(input: unknown, create: boolean): ValidationResult<UpdateTrackedSearchInput> {
  if (!isObject(input)) return invalidBody();
  const errors: Record<string, string[]> = {};
  const data: UpdateTrackedSearchInput = {};

  for (const [field, label, max] of [['query', 'Query', 100], ['category', 'Category', 50]] as const) {
    if (!create && input[field] === undefined) continue;
    const value = typeof input[field] === 'string' ? sanitizeString(input[field]) : '';
    if (!value) errors[field] = [`${label} is required and cannot be empty`];
    else if (value.length < 2 || value.length > max) errors[field] = [`${label} must be between 2 and ${max} characters`];
    else data[field] = value;
  }

  const kw = input.negativeKeywords;
  if (kw != null) {
    if (typeof kw !== 'string') errors.negativeKeywords = ['Negative keywords must be a string'];
    else if (kw.length > 500) errors.negativeKeywords = ['Negative keywords cannot exceed 500 characters'];
    else data.negativeKeywords = sanitizeString(kw);
  }

  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') errors.isActive = ['isActive must be a boolean'];
    else data.isActive = input.isActive;
  } else if (create) {
    data.isActive = true;
  }

  if (Object.keys(errors).length) return { success: false, errors };
  if (!create && !Object.keys(data).length) {
    return { success: false, errors: { body: ['At least one field must be provided for update'] } };
  }
  return { success: true, data };
}

export function validateCreateTrackedSearch(input: unknown): ValidationResult<CreateTrackedSearchInput> {
  const result = validateSearchFields(input, true);
  if (!result.success) return result;
  // Required fields have been checked by the shared create policy.
  return { success: true, data: { ...result.data, query: result.data.query!, category: result.data.category! } };
}

export function validateUpdateTrackedSearch(input: unknown): ValidationResult<UpdateTrackedSearchInput> {
  return validateSearchFields(input, false);
}

// Pagination & Query Parameter Validators

const VALID_SORT_OPTIONS: ListingSortOption[] = ['priceAsc', 'priceDesc', 'newest', 'oldest'];

function validateParam<T>(
  raw: unknown,
  parser: (val: unknown) => T | undefined,
  field: string,
  errorMsg: string,
  errors: Record<string, string[]>,
  skipEmpty = true
): T | undefined {
  if (raw === undefined || (skipEmpty && raw === '')) return undefined;
  const parsed = parser(raw);
  if (parsed === undefined) errors[field] = [errorMsg];
  return parsed;
}

export function validatePaginationQuery(
  params: Record<string, unknown>
): ValidationResult<PaginationQuery> {
  const errors: Record<string, string[]> = {};

  const page = validateParam(params.page, parseId, 'page', 'page must be a positive integer', errors, false) ?? 1;
  const limit = validateParam(
    params.limit,
    (v) => { const n = parseId(v); return n !== undefined && n <= 100 ? n : undefined; },
    'limit',
    'limit must be an integer between 1 and 100',
    errors,
    false
  ) ?? 25;

  if (!Number.isSafeInteger((page - 1) * limit)) {
    errors.page = ['page offset exceeds the safe integer range'];
  }

  const searchId = validateParam(params.searchId, parseId, 'searchId', 'searchId must be a valid positive integer', errors);

  // Blank optional filters remain absent; nonblank input must survive sanitization.
  let query: string | undefined;
  if (params.query !== undefined && params.query !== '') {
    if (typeof params.query !== 'string') errors.query = ['query must be a string'];
    else if (params.query.trim() || /[\u0000-\u001F\u007F]/.test(params.query)) {
      query = sanitizeString(params.query);
      if (!query) errors.query = ['query cannot be empty after sanitization'];
    }
  }

  const [isSold, isActive] = (['isSold', 'isActive'] as const).map((field) =>
    validateParam(params[field], parseBoolean, field, `${field} must be a boolean (true/false, 1/0)`, errors)
  );

  const parsePrice = (v: unknown) => { const n = parseNumber(v); return n !== undefined && n >= 0 ? n : undefined; };
  const [minPrice, maxPrice] = (['minPrice', 'maxPrice'] as const).map((field) =>
    validateParam(params[field], parsePrice, field, `${field} must be a non-negative number`, errors)
  );

  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    errors.priceRange = ['minPrice cannot be greater than maxPrice'];
  }

  const sortBy = validateParam(
    params.sortBy,
    (v) => VALID_SORT_OPTIONS.includes(String(v) as ListingSortOption) ? (String(v) as ListingSortOption) : undefined,
    'sortBy',
    `sortBy must be one of: ${VALID_SORT_OPTIONS.join(', ')}`,
    errors
  ) ?? 'newest';

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      page,
      limit,
      searchId,
      query,
      isSold,
      isActive,
      minPrice,
      maxPrice,
      sortBy,
    },
  };
}

// Scrape Trigger Validator

export function validateScrapeTrigger(
  input: unknown
): ValidationResult<{ searchId?: number }> {
  if (!isObject(input)) return invalidBody();
  if (input.searchId == null || input.searchId === '') return { success: true, data: {} };
  const searchId = parseId(input.searchId);
  return searchId === undefined
    ? { success: false, errors: { searchId: ['searchId must be a valid positive integer'] } }
    : { success: true, data: { searchId } };
}
