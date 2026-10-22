/**
 * Live model metadata from models.dev, the catalog opencode uses. Provider /models
 * endpoints list model ids but mostly not limits or reasoning options; this fills them
 * in at runtime, so no model data is hardcoded. Shared verbatim across the provider
 * extensions; keep the copies in sync.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface ReasoningOption {
  type?: string;
  values?: unknown[];
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  tool_call?: boolean;
  reasoning_options?: ReasoningOption[];
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  release_date?: string;
}

export interface ModelsDevCache {
  etag?: string;
  /** Per model id: its metadata, or null when models.dev has none. */
  models: Record<string, ModelsDevModel | null>;
  /** Models models.dev lists for this API that its own /models doesn't list yet, newest first. */
  extra?: string[];
}

export interface ReasoningChoices {
  values: string[];
  defaultValue: string;
}

export interface TokenLimits {
  maxContextWindowTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

interface ModelsDevProvider {
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/**
 * Metadata for the given model ids. When the cache already covers every id it only
 * revalidates (ETag, a cheap 304); otherwise it downloads the catalog (~0.5 MB gzipped).
 * Throws on network errors so callers keep their previous data.
 */
export async function resolveModelsDev(
  baseUrl: string,
  ids: readonly string[],
  cache?: ModelsDevCache,
): Promise<ModelsDevCache> {
  const covered = cache !== undefined && ids.every((id) => id in cache.models);
  const headers: Record<string, string> = covered && cache?.etag ? { 'If-None-Match': cache.etag } : {};
  const res = await fetch(MODELS_DEV_URL, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 304 && cache) return cache;
  if (!res.ok) throw new Error(`models.dev request failed (HTTP ${res.status})`);
  const catalog = (await res.json()) as ModelsDevCatalog;
  const models: Record<string, ModelsDevModel | null> = {};
  for (const id of ids) models[id] = trim(findModel(catalog, baseUrl, id));
  const extra = newerThanListed(catalog, baseUrl, ids);
  for (const model of extra) models[model.id] = trim(model);
  return { etag: res.headers.get('etag') ?? undefined, models, extra: extra.map((model) => model.id) };
}

/**
 * A provider can serve a new model before its /models lists it (MiniMax's M3.1 Flash did). The models models.dev
 * lists for this same API that are newer than anything /models returns are offered too; a preview is left out once
 * its release is there. Nothing here names a model: both lists are read live.
 */
export function newerThanListed(catalog: ModelsDevCatalog, baseUrl: string, ids: readonly string[]): ModelsDevModel[] {
  const own = sameApi(catalog, baseUrl);
  const listed = new Set(ids);
  const newest = own.filter((model) => listed.has(model.id)).map((model) => model.release_date ?? '').sort().at(-1);
  if (!newest) return [];
  const all = new Set(own.map((model) => model.id));
  const fresh = own.filter((model) => !listed.has(model.id) && (model.release_date ?? '') > newest && writesText(model));
  const kept = fresh.filter((model) => !isPreviewOf(model.id, all));
  return [...new Map(kept.map((model) => [model.id, model])).values()].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
}

const writesText = (model: ModelsDevModel): boolean => !model.modalities?.output || model.modalities.output.includes('text');

function isPreviewOf(id: string, all: Set<string>): boolean {
  const release = id.replace(/[-_.]?preview(?:[-_.]?\d+)?$/i, '');
  return release !== id && all.has(release);
}

/** The models of the providers whose API is ours: the exact URL, else the same host. */
function sameApi(catalog: ModelsDevCatalog, baseUrl: string): ModelsDevModel[] {
  const providers = Object.values(catalog).filter((provider) => provider.api !== undefined);
  const exact = providers.filter((provider) => normalizeUrl(provider.api!) === normalizeUrl(baseUrl));
  const chosen = exact.length ? exact : providers.filter((provider) => hostOf(provider.api!) === hostOf(baseUrl));
  return chosen.flatMap((provider) => Object.entries(provider.models ?? {}).map(([id, model]) => ({ ...model, id })));
}

/** Copilot's own BYOK convention: the prompt budget is the window minus the output reservation. */
export function tokenLimits(context: number, output: number): TokenLimits {
  const maxOutputTokens = Math.min(output, context);
  return { maxContextWindowTokens: context, maxOutputTokens, maxInputTokens: Math.max(0, context - maxOutputTokens) };
}

/**
 * Picker choices built only from live data: 'off' disables thinking (live toggle), 'on'
 * enables it (toggle without effort levels), anything else is a live effort level.
 * Without a live default, 'auto' (send nothing, the API decides) is the default.
 * Undefined when the model exposes no reasoning controls.
 */
export function reasoningChoices(
  options: ReasoningOption[] | undefined,
  live?: { levels?: string[]; defaultLevel?: string },
): ReasoningChoices | undefined {
  const toggle = (options ?? []).some((option) => option.type === 'toggle');
  const levels = live?.levels?.length ? live.levels : effortLevels(options);
  const values = [...(toggle ? ['off'] : []), ...(levels.length > 0 ? levels : toggle ? ['on'] : [])];
  if (values.length === 0) return undefined;
  const liveDefault = live?.defaultLevel;
  if (liveDefault && values.includes(liveDefault)) return { values, defaultValue: liveDefault };
  return { values: ['auto', ...values], defaultValue: 'auto' };
}

/** The configured picker value if the model still offers it live, else the model's default. */
export function resolveReasoningChoice(choices: ReasoningChoices | undefined, configured: unknown): string | undefined {
  if (!choices) return undefined;
  return typeof configured === 'string' && choices.values.includes(configured) ? configured : choices.defaultValue;
}

/** OpenAI-compatible request fields for a picker value; `onType` is the API's thinking-on value. */
export function reasoningRequestFields(choice: string | undefined, onType: 'enabled' | 'adaptive'): Record<string, unknown> {
  if (choice === undefined || choice === 'auto') return {};
  if (choice === 'off') return { thinking: { type: 'disabled' } };
  if (choice === 'on') return { thinking: { type: onType } };
  return { thinking: { type: onType }, reasoning_effort: choice };
}

/** VS Code model picker schema (navigation group = shown right in the picker). */
export function reasoningSchema(choices: ReasoningChoices): object {
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Reasoning Effort',
        enum: choices.values,
        enumItemLabels: choices.values.map((value) => value.charAt(0).toUpperCase() + value.slice(1)),
        default: choices.defaultValue,
        group: 'navigation',
      },
    },
  };
}

function effortLevels(options: ReasoningOption[] | undefined): string[] {
  const values = (options ?? []).find((option) => option.type === 'effort')?.values ?? [];
  return values.filter((value): value is string => typeof value === 'string');
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Prefer the provider whose API base matches ours: exact URL, then same host, then any listing. */
function findModel(catalog: ModelsDevCatalog, baseUrl: string, id: string): ModelsDevModel | undefined {
  const providers = Object.values(catalog);
  const base = normalizeUrl(baseUrl);
  const host = hostOf(baseUrl);
  const tiers = [
    providers.filter((provider) => provider.api !== undefined && normalizeUrl(provider.api) === base),
    providers.filter((provider) => provider.api !== undefined && hostOf(provider.api) === host),
    providers,
  ];
  for (const tier of tiers) {
    const match = tier.map((provider) => provider.models?.[id]).find((model) => model !== undefined);
    if (match) return match;
  }
  return undefined;
}

function trim(model: ModelsDevModel | undefined): ModelsDevModel | null {
  if (!model) return null;
  const { id, name, tool_call, reasoning_options, modalities, limit, release_date } = model;
  return { id, name, tool_call, reasoning_options, modalities, limit, release_date };
}
