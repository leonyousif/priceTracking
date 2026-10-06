export interface TrackedSearch {
  id: number;
  query: string;
  category: string;
  negativeKeywords: string | null;
  isActive: boolean;
  lastScrapedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Listing {
  id: number;
  searchId: number;
  platform: string;
  externalId: string;
  title: string;
  currentPrice: number;
  currency: string;
  url: string;
  imageUrl: string | null;
  location: string | null;
  sellerName: string | null;
  isSold: number | boolean;
  isActive: number | boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  postage: number | null;
  estimatedDeliveredCost: number | null;
}

export interface PriceHistory {
  id: number;
  listingId: number;
  price: number;
  recordedAt: string;
}

export type DealStatus = 'ACTIVE' | 'EXPIRED' | 'SOLD' | 'DISMISSED' | 'DELISTED';

export interface Deal {
  id: number;
  listingId: number;
  searchId: number;
  listingPrice: number;
  baselineMarketPrice: number;
  discountPercentage: number;
  status: DealStatus;
  detectedAt: string;
  isActive: number | boolean;
  postage: number | null;
  estimatedDeliveredCost: number | null;
}

// Scraper & Pipeline Types

export interface RawScrapedItem {
  platform: string;
  externalId: string;
  title: string;
  currentPrice: number;
  currency: string;
  url: string;
  imageUrl?: string | null;
  location?: string | null;
  sellerName?: string | null;
  isSold: boolean;
  postage?: number | null;
  estimatedDeliveredCost?: number | null;
}

export interface ScrapeResult {
  platform: string;
  items: RawScrapedItem[];
  status: 'success' | 'partial' | 'blocked' | 'failed';
  errorMessage?: string;
  pagesAttempted: number;
  pagesCompleted: number;
}

export interface IngestionResult {
  totalItems: number;
  newItems: number;
  updatedItems: number;
  priceChanges: number;
  filteredOutliers: number;
  activeDealsFound: number;
  delistedListings?: number;
  delistedDeals?: number;
}

export type ScrapeJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface ScrapeJob {
  id: number;
  searchId: number | null;
  status: ScrapeJobStatus;
  itemsScraped: number;
  /** Final ACTIVE deal count across the job's search scope, including preexisting deals. */
  dealsFound: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  ownerId?: string | null;
  attemptId?: string | null;
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
}

export interface TriggerJobAdmissionResult {
  jobId: number;
  status: ScrapeJobStatus;
  isDuplicate: boolean;
  message: string;
}

// Request & Input Types

export interface CreateTrackedSearchInput {
  query: string;
  category: string;
  negativeKeywords?: string;
  isActive?: boolean;
}

export interface UpdateTrackedSearchInput {
  query?: string;
  category?: string;
  negativeKeywords?: string;
  isActive?: boolean;
}

export type ListingSortOption = 'priceAsc' | 'priceDesc' | 'newest' | 'oldest';

export interface PaginationQuery {
  page: number;
  limit: number;
  searchId?: number;
  query?: string;
  isSold?: boolean;
  isActive?: boolean;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: ListingSortOption;
}

export interface ListingsFilterQuery extends PaginationQuery {
  searchId?: number;
  minPrice?: number;
  maxPrice?: number;
  isActive?: boolean;
  isSold?: boolean;
  sortBy?: ListingSortOption;
  q?: string;
}

export interface DealsFilterQuery extends PaginationQuery {
  searchId?: number;
  status?: string;
  minDiscount?: number;
}

// API Response Types

/** SQLite flags are serialized as 0/1; domain inputs continue to use booleans. */
export type SqliteFlag = 0 | 1;
export type TrackedSearchRow = Omit<TrackedSearch, 'isActive'> & { isActive: SqliteFlag };
export type ListingRow = Omit<Listing, 'searchId' | 'isSold' | 'isActive'> & {
  searchId: number | null;
  isSold: SqliteFlag;
  isActive: SqliteFlag;
};
export type DealRow = Omit<Deal, 'detectedAt' | 'isActive'> & {
  dealType: 'BELOW_MARKET';
  flaggedAt: string;
  isActive: SqliteFlag;
};

// Wire DTOs describe the selected columns, not a database SELECT * or input model.
export type SearchDto = Pick<TrackedSearchRow,
  'id' | 'query' | 'category' | 'negativeKeywords' | 'isActive' | 'createdAt' | 'updatedAt' | 'lastScrapedAt'>;
export type SearchSummaryDto = SearchDto & {
  activeListingsCount: number;
  totalListingsCount: number;
  activeDealsCount: number;
};
export type SearchDetailDto = SearchDto & { listingCount: number; activeDealsCount: number };
export type SearchOption = Pick<SearchDto, 'id' | 'query'>;
export type ListingDto = Pick<ListingRow,
  'id' | 'searchId' | 'platform' | 'externalId' | 'title' | 'currentPrice' | 'currency' | 'url' |
  'imageUrl' | 'location' | 'sellerName' | 'isSold' | 'isActive' | 'firstSeenAt' | 'lastSeenAt' | 'postage' | 'estimatedDeliveredCost'> & {
  searchQuery: string | null;
  category: string | null;
};
export type DealDto = Pick<DealRow,
  'id' | 'listingId' | 'searchId' | 'listingPrice' | 'postage' | 'estimatedDeliveredCost' | 'baselineMarketPrice' |
  'discountPercentage' | 'dealType' | 'status' | 'isActive' | 'flaggedAt'> & Pick<ListingDto,
  'title' | 'url' | 'imageUrl' | 'location' | 'sellerName' | 'currency' | 'platform'> & {
  searchQuery: string;
  category: string;
  estimatedDeliveredCost: number;
};
export type ScrapeJobRow = Required<ScrapeJob>;
export type JobDto = Pick<ScrapeJobRow,
  'id' | 'searchId' | 'status' | 'itemsScraped' | 'dealsFound' | 'errorMessage' | 'startedAt' | 'completedAt' |
  'ownerId' | 'claimedAt' | 'heartbeatAt' | 'leaseExpiresAt'> & { durationMs: number | null };
export type HistoryListingDto = Pick<ListingRow,
  'id' | 'title' | 'currentPrice' | 'currency' | 'url' | 'isSold' | 'isActive'>;
export type PricePointDto = Pick<PriceHistory, 'id' | 'price' | 'recordedAt'>;
export interface DailyTrendDto {
  date: string;
  medianItemPrice: number;
  minItemPrice: number;
  maxItemPrice: number;
  avgItemPrice: number;
  eventCount: number;
}
export interface DealSummary { count: number; avgDiscount: number; maxDiscount: number }
export interface ApiFailure { success: false; errors: Record<string, string[]> }
export type ApiResponse<T extends object> = ({ success: true } & T) | ApiFailure;
export interface PageMeta { total: number; page: number; limit: number; totalPages: number }
export type SearchesResponse = ApiResponse<{ data: SearchSummaryDto[] }>;
export type SearchOptionsResponse = ApiResponse<{ data: SearchOption[] }>;
export type CreateSearchResponse = ApiResponse<{ data: SearchDto }>;
export type UpdateSearchResponse = ApiResponse<{ data: SearchDto; search: SearchDto }>;
export type SearchDetailResponse = ApiResponse<{ data: SearchDetailDto; search: SearchDetailDto }>;
export type DeleteSearchResponse = ApiResponse<{ message: string; mode: 'hard' | 'soft' }>;
export type ListingsResponse = ApiResponse<{ items: ListingDto[] } & PageMeta>;
export type DealsResponse = ApiResponse<{ data: DealDto[]; summary: DealSummary } & PageMeta>;
export type JobsResponse = ApiResponse<{ jobs: JobDto[] }>;
export type JobResponse = ApiResponse<{ job: JobDto }>;
export type TriggerResponse = ApiResponse<{
  jobId: number; status: ScrapeJobStatus; duplicate: boolean; message: string;
}>;
export type ListingHistoryResponse = ApiResponse<{
  mode: 'listing'; listing: HistoryListingDto; history: PricePointDto[];
  semantics: 'item_price_events'; predecessor: PricePointDto | null;
} & PageMeta>;
export type SearchHistoryResponse = ApiResponse<{
  mode: 'search'; search: Pick<SearchDto, 'id' | 'query' | 'category'>; trends: DailyTrendDto[];
  semantics: 'item_price_events'; startDate: string; endDate: string;
}>;

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: Record<string, string[]> };
