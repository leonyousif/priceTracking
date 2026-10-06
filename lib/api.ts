import { NextResponse } from 'next/server';
import { ApiFailure, ValidationResult } from './types';

export function errorResponse(errors: Record<string, string[]>, status = 400) {
  return NextResponse.json<ApiFailure>({ success: false, errors }, { status });
}

/** Empty bodies are supported only by the scrape-trigger endpoint. */
export async function readJsonBody(request: Request, allowEmpty = false): Promise<ValidationResult<unknown>> {
  try {
    const text = await request.text();
    return { success: true, data: allowEmpty && !text.trim() ? {} : JSON.parse(text) };
  } catch {
    return { success: false, errors: { body: ['Invalid JSON payload'] } };
  }
}
